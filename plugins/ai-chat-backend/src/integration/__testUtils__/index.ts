/*
 * Copyright 2026 The backstage-plugin-ai-chat Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  ActionsService,
  ActionsServiceAction,
} from '@backstage/backend-plugin-api/alpha';
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type { JsonObject } from '@backstage/types';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import {
  FakeClock,
  ScriptedModel,
  SequentialIdGenerator,
  type ScriptedStep,
} from '@kwkevinchan/ai-chat-harness/testing';
import type {
  Extensions,
  ItemLog,
  Limits,
  ModelClient,
} from '@kwkevinchan/ai-chat-harness';
import type { ChatInputConfig } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { ActionsToolGateway } from '../../adapters/backstage/ActionsToolGateway';
import { ConfigAgentCatalog } from '../../adapters/backstage/ConfigAgentCatalog';
import { KnexAttachmentStore } from '../../adapters/persistence/KnexAttachmentStore';
import { KnexItemLog } from '../../adapters/persistence/KnexItemLog';
import { KnexQueuedMessageRepository } from '../../adapters/persistence/KnexQueuedMessageRepository';
import { KnexRunRepository } from '../../adapters/persistence/KnexRunRepository';
import { KnexSessionRepository } from '../../adapters/persistence/KnexSessionRepository';
import { KnexShareRepository } from '../../adapters/persistence/KnexShareRepository';
import {
  CreateSession,
  OwnerOrShareAccessControl,
  TITLE_PROMPT_MARK,
  type HostEvent,
  type ImageSettings,
  type RunHandle,
} from '../../application';
import type {
  AuditEvent,
  AuditLog,
  EntityReader,
  Notifier,
} from '../../application/ports';
import {
  DEFAULT_IMAGE_LIMITS,
  type EntityFacts,
  type Principal,
  type Run,
} from '../../domain';
import { createHost, type HostPorts } from '../../host';
import { createMigratedDb } from '../../__testUtils__';

// A host on a real database: sessions, runs and items in SQLite (PostgreSQL in
// CI), the real tool gateway on a fake actions registry, and a scripted model.
// `backend()` makes another backend on the same database.

function action(
  id: string,
  readOnly: boolean,
  output: unknown,
): ActionsServiceAction {
  return {
    id,
    pluginId: 'demo',
    name: id.split(':')[1],
    title: id,
    description: `The action ${id}`,
    schema: {
      input: {
        type: 'object',
        properties: { name: { type: 'string' } },
      } as any,
      output: { type: 'object' },
    },
    attributes: { readOnly, destructive: !readOnly, idempotent: readOnly },
    // The output the fake returns.
    ...({ output } as object),
  } as ActionsServiceAction;
}

export class FakeActions implements ActionsService {
  readonly invocations: {
    id: string;
    input: unknown;
    credentials: BackstageCredentials;
  }[] = [];
  readonly actions = [
    action('demo:read', true, { things: ['a'] }),
    action('demo:write', false, { changed: true }),
    action('demo:write2', false, { changed: 2 }),
  ];

  list = async (_options: { credentials: BackstageCredentials }) => ({
    actions: this.actions,
  });

  invoke = async (options: {
    id: string;
    input?: unknown;
    credentials: BackstageCredentials;
  }): Promise<{ output: any }> => {
    this.invocations.push({
      id: options.id,
      input: options.input,
      credentials: options.credentials,
    });
    return {
      output: (this.actions.find(a => a.id === options.id) as any).output,
    };
  };

  count(id: string): number {
    return this.invocations.filter(call => call.id === id).length;
  }
}

export class RecordingAuditLog implements AuditLog {
  readonly events: (AuditEvent & { outcome?: 'success' | 'fail' })[] = [];

  async begin(event: AuditEvent) {
    const record: AuditEvent & { outcome?: 'success' | 'fail' } = {
      ...event,
    };
    this.events.push(record);
    return {
      success: async () => {
        record.outcome = 'success';
      },
      fail: async () => {
        record.outcome = 'fail';
      },
    };
  }

  ids(): string[] {
    return this.events.map(e => e.eventId);
  }
}

/**
 * A catalog for the tests: the entities by their normalized ref, each one
 * readable by everyone or only by the users in `readers`. With `failing`,
 * every read throws, as a catalog that cannot be reached does.
 */
export class FakeEntityReader implements EntityReader {
  failing = false;
  /** Every read waits for ever, as a catalog that does not answer. */
  hanging = false;
  readonly reads: { entityRef: string; principal: Principal }[] = [];

  constructor(
    private readonly entities: {
      ref: string;
      facts?: Partial<EntityFacts>;
      readers?: string[];
    }[] = [],
  ) {}

  async read(
    entityRef: string,
    principal: Principal,
  ): Promise<EntityFacts | undefined> {
    this.reads.push({ entityRef, principal });
    if (this.hanging) return new Promise(() => undefined);
    if (this.failing) {
      throw new Error('catalog at http://catalog.internal is down');
    }
    const found = this.entities.find(entity => entity.ref === entityRef);
    if (!found) return undefined;
    if (found.readers && !found.readers.includes(principal.userRef)) {
      return undefined;
    }
    const [kind, rest] = entityRef.split(':');
    const [namespace, name] = rest.split('/');
    return { kind, namespace, name, ...found.facts };
  }
}

export const jane: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: mockCredentials.user('user:default/jane'),
};
/**
 * Jane with credentials that stay valid for a day after the start of the fake
 * clock: the queue starts the next run only for credentials that last (IN-16).
 */
export const janeFresh: Principal = {
  ...jane,
  credentialsExpireAt: '2026-01-02T00:00:00.000Z',
};
export const mallory: Principal = {
  userRef: 'user:default/mallory',
  ownershipRefs: ['user:default/mallory'],
  credentials: mockCredentials.user('user:default/mallory'),
};

/** The answer of `GET /input-config` for a router in a test. */
export const testInputConfig: ChatInputConfig = {
  images: {
    enabled: true,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxPerMessage: 4,
    maxBytes: 5 * 1024 * 1024,
    maxBytesPerInput: 20 * 1024 * 1024,
    maxPendingPerSession: 12,
  },
  insertMaxPerRun: 5,
  queueMaxMessages: 5,
};

/**
 * Answers a title request without touching the scripted model, so a call that
 * names the session does not consume a step or show up in `inputs`.
 */
function withTitleAnswers(scripted: ScriptedModel): ModelClient {
  return {
    capabilities: scripted.capabilities,
    async *stream(input, opts) {
      if (input.system.startsWith(TITLE_PROMPT_MARK)) {
        yield { type: 'text', text: 'Generated title' };
        return;
      }
      yield* scripted.stream(input, opts);
    },
  };
}

export async function createWorld(
  options: {
    leaseSeconds?: number;
    limits?: Partial<Limits>;
    /** The limits on images, and whether the model reads them (it does by default). */
    images?: Partial<ImageSettings>;
    /** `aiChat.input.insert.maxPerRun`; 5 by default. */
    insertMaxPerRun?: number;
    agents?: JsonObject;
    policy?: JsonObject;
    /** `aiChat.runsPerUser`; 3 by default. */
    runsPerUser?: number;
    /** The catalog the sessions are bound with; empty by default. */
    entities?: EntityReader;
  } = {},
) {
  const entities = options.entities ?? new FakeEntityReader();
  const knex = await createMigratedDb();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator('id');
  const images: ImageSettings = {
    ...DEFAULT_IMAGE_LIMITS,
    enabled: true,
    ...options.images,
  };
  const items = new KnexItemLog(knex, clock, {
    maxInsertsPerRun: options.insertMaxPerRun,
    maxImageBytesPerInput: images.maxBytesPerInput,
  });
  const attachments = new KnexAttachmentStore(knex, clock, ids);
  const sessions = new KnexSessionRepository(knex, clock, ids);
  const actions = new FakeActions();
  const audit = new RecordingAuditLog();
  const queue = new KnexQueuedMessageRepository(knex, clock, ids, {
    leaseSeconds: options.leaseSeconds,
    runsPerUser: options.runsPerUser,
  });
  const catalog = new ConfigAgentCatalog(
    mockServices.rootConfig({
      data: {
        aiChat: {
          toolsets: { demo: { actions: ['demo:*'], default: true } },
          ...(options.agents && { agents: options.agents }),
          ...(options.policy && { policy: options.policy }),
        },
      },
    }),
    mockServices.logger.mock(),
  );
  const limits: Limits = {
    maxSteps: 10,
    maxToolCallsPerRun: 30,
    runTimeoutSeconds: 300,
    maxToolCallsPerStep: 8,
    readConcurrency: 4,
    toolTimeoutSeconds: 60,
    ...options.limits,
  };

  /** Another backend process on the same database. */
  function backend(
    script: ScriptedStep[],
    extra: {
      items?: (inner: ItemLog) => ItemLog;
      model?: ModelClient;
      /** The clients of the models besides `default`. */
      models?: ReadonlyMap<string, ModelClient>;
      rateLimits?: HostPorts['rateLimits'];
      notifier?: Notifier;
      extensions?: Extensions;
      heartbeatMs?: number;
      /**
       * Runs around every `transition` of this backend: `call()` makes the
       * change. For tests that need something to happen just before or after.
       */
      aroundTransition?: (
        info: { runId: string; to: string },
        call: () => Promise<Run>,
      ) => Promise<Run>;
    } = {},
  ) {
    const model = new ScriptedModel(script, { images: images.enabled });
    // A title call is not a step of the script: the tests keep counting the
    // calls of the conversation, and a session that ends normally is named.
    const modelForHost = withTitleAnswers(model);
    const runs = new KnexRunRepository(knex, clock, ids, {
      leaseSeconds: options.leaseSeconds,
      runsPerUser: options.runsPerUser,
    });
    const logger = mockServices.logger.mock();
    const hooked = extra.aroundTransition
      ? (new Proxy(runs, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === 'transition') {
              return (runId: string, to: string, opts: unknown) =>
                extra.aroundTransition!({ runId, to }, () =>
                  (target.transition as any)(runId, to, opts),
                );
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as KnexRunRepository)
      : runs;
    const host = createHost({
      items: extra.items ? extra.items(items) : items,
      sessions,
      runs: hooked,
      queue,
      attachments,
      shares: new KnexShareRepository(knex, clock, ids),
      access: new OwnerOrShareAccessControl(),
      entities,
      images,
      insertMaxPerRun: options.insertMaxPerRun,
      agents: catalog,
      tools: new ActionsToolGateway({
        actions,
        catalog,
        logger,
        enabledToolsets: async ctx =>
          (await sessions.get(ctx.sessionId)).enabledToolsets,
        maxOutputChars: 20000,
      }),
      model: extra.model ?? modelForHost,
      ...(extra.models && { models: extra.models }),
      ...(extra.rateLimits && { rateLimits: extra.rateLimits }),
      audit,
      clock,
      ids,
      logger,
      ...(extra.notifier && { notifier: extra.notifier }),
      ...(extra.extensions && { extensions: extra.extensions }),
      settings: {
        limits,
        budget: { tokenBudget: 100000, keepRecentSteps: 6 },
      },
      heartbeatMs: extra.heartbeatMs ?? 60_000,
    });
    return { ...host, model, runs, logger };
  }

  return {
    knex,
    clock,
    items,
    queue,
    attachments,
    sessions,
    actions,
    audit,
    backend,
    async newSession(principal: Principal = jane, agentId?: string) {
      return new CreateSession({
        sessions,
        agents: catalog,
        entities,
      }).execute({
        principal,
        ...(agentId !== undefined && { agentId }),
      });
    },
    async runRow(runId: string) {
      return knex('runs').where({ id: runId }).first();
    },
    /** PostgreSQL gives a count as text, SQLite as a number. */
    async runCount() {
      const [row] = await knex('runs').count({ n: '*' });
      return Number(row.n);
    },
    async runningRows() {
      return knex('runs').whereIn('status', ['running']).select('id');
    },
    cleanup: () => knex.destroy(),
  };
}

/** Reads the events to the end and waits for the run to be up to date. */
export async function drain(handle: RunHandle): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for await (const event of handle.events) events.push(event);
  await handle.done;
  return events;
}

/** Waits until `condition` holds, or fails after five seconds. */
export async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

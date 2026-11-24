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
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import {
  FakeClock,
  ScriptedModel,
  SequentialIdGenerator,
  type ScriptedStep,
} from '@kwkevinchan/ai-chat-harness/testing';
import type {
  HarnessEvent,
  ItemLog,
  Limits,
} from '@kwkevinchan/ai-chat-harness';
import { ActionsToolGateway } from '../../adapters/backstage/ActionsToolGateway';
import { ConfigAgentCatalog } from '../../adapters/backstage/ConfigAgentCatalog';
import { KnexItemLog } from '../../adapters/persistence/KnexItemLog';
import { KnexRunRepository } from '../../adapters/persistence/KnexRunRepository';
import { KnexSessionRepository } from '../../adapters/persistence/KnexSessionRepository';
import { CreateSession, type RunHandle } from '../../application';
import type { AuditEvent, AuditLog } from '../../application/ports';
import type { Principal } from '../../domain';
import { createHost } from '../../host';
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

export const jane: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: mockCredentials.user('user:default/jane'),
};
export const mallory: Principal = {
  userRef: 'user:default/mallory',
  ownershipRefs: ['user:default/mallory'],
  credentials: mockCredentials.user('user:default/mallory'),
};

export async function createWorld(
  options: { leaseSeconds?: number; limits?: Partial<Limits> } = {},
) {
  const knex = await createMigratedDb();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator('id');
  const items = new KnexItemLog(knex, clock);
  const sessions = new KnexSessionRepository(knex, clock, ids);
  const actions = new FakeActions();
  const audit = new RecordingAuditLog();
  const catalog = new ConfigAgentCatalog(
    mockServices.rootConfig({
      data: {
        aiChat: {
          toolsets: { demo: { actions: ['demo:*'], default: true } },
        },
      },
    }),
    mockServices.logger.mock(),
  );
  const limits: Limits = {
    maxSteps: 10,
    maxToolCallsPerRun: 30,
    runTimeoutSeconds: 300,
    ...options.limits,
  };

  /** Another backend process on the same database. */
  function backend(
    script: ScriptedStep[],
    extra: { items?: (inner: ItemLog) => ItemLog; heartbeatMs?: number } = {},
  ) {
    const model = new ScriptedModel(script);
    const runs = new KnexRunRepository(knex, clock, ids, {
      leaseSeconds: options.leaseSeconds,
    });
    const logger = mockServices.logger.mock();
    const host = createHost({
      items: extra.items ? extra.items(items) : items,
      sessions,
      runs,
      agents: catalog,
      tools: new ActionsToolGateway({
        actions,
        catalog,
        logger,
        enabledToolsets: async ctx =>
          (await sessions.get(ctx.sessionId)).enabledToolsets,
        maxOutputChars: 20000,
      }),
      model,
      audit,
      clock,
      ids,
      logger,
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
    sessions,
    actions,
    audit,
    backend,
    async newSession(principal: Principal = jane) {
      return new CreateSession({ sessions, agents: catalog }).execute({
        principal,
      });
    },
    async runRow(runId: string) {
      return knex('runs').where({ id: runId }).first();
    },
    async runningRows() {
      return knex('runs').whereIn('status', ['running']).select('id');
    },
    cleanup: () => knex.destroy(),
  };
}

/** Reads the events to the end and waits for the run to be up to date. */
export async function drain(handle: RunHandle): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
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

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

import type { ModelCatalog } from '../models';
import {
  CONTEXT_PROVIDER_TIMEOUT_MS,
  type Clock,
  type ItemLog,
} from '@kwkevinchan/ai-chat-harness';
import {
  assertOwner,
  ShuttingDown,
  type Principal,
  type Session,
} from '../../domain';
import { abandonRun } from '../abandonRun';
import { buildRunRequest, type RunSettings } from '../buildRunRequest';
import { readableEntityRef } from '../entityContext';
import { errorLogFields } from '../modelErrors';
import type { ActivityNotifier } from '../notifyActivity';
import type { RunHandle, RunSupervisor } from '../RunSupervisor';
import {
  bindAttachments,
  toAttachmentRef,
  type ImageSettings,
} from '../attachments';
import type {
  AgentCatalog,
  AttachmentStore,
  EntityReader,
  Logger,
  RunRepository,
  SessionRepository,
} from '../ports';

/**
 * The message of the user starts a run, and the loop works on it in the
 * background (H-01, D-16).
 */
export class SendMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      supervisor: RunSupervisor;
      agents: AgentCatalog;
      models: ModelCatalog;
      clock: Clock;
      settings: RunSettings;
      attachments: AttachmentStore;
      images: ImageSettings;
      entities: EntityReader;
      notify?: ActivityNotifier;
      logger?: Logger;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `RunAlreadyActive` (H-03), `ShuttingDown`, or,
   * for the images, `ImagesNotSupported`, `TooManyAttachments` or
   * `UnknownAttachment` (nothing is written then, and no run starts).
   * The run comes first: the message of the user is written only once the
   * session has the run, so a message that the session cannot take (another
   * run is active) is not left in the log.
   *
   * The first message of a session that is bound to no entity binds it to
   * the entity of its page (SE-02: a session opened on the page of an
   * entity), when the user can read that entity. Otherwise the message is
   * sent as it is, unbound.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    text: string;
    attachmentIds?: string[];
    page?: { path: string; entityRef?: string };
  }): Promise<RunHandle> {
    const {
      sessions,
      runs,
      items,
      supervisor,
      agents,
      models,
      clock,
      settings,
    } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    if (!supervisor.accepting) throw new ShuttingDown();
    const attachments = await bindAttachments(
      this.deps,
      session.id,
      input.attachmentIds,
    );

    const run = await runs.start(session.id);
    try {
      const bound = await this.bindToPage(session, input);
      const request = await buildRunRequest(
        { agents, models, clock, settings },
        {
          session:
            bound === undefined ? session : { ...session, entityRef: bound },
          run,
          principal: input.principal,
          page: input.page,
        },
      );
      await items.append(
        session.id,
        [
          {
            kind: 'user_message',
            text: input.text,
            ...(attachments.length > 0 && {
              attachments: attachments.map(toAttachmentRef),
            }),
            ...(input.page && { page: input.page }),
          },
        ],
        run.fence,
      );
      return supervisor.launch(run, request);
    } catch (error) {
      await abandonRun(runs, run, {
        notify: this.deps.notify,
        logger: this.deps.logger,
      });
      throw error;
    }
  }

  /**
   * The entity the session is bound to after this call: the page binds a
   * session that is bound to none and has nothing in its log yet. A failure
   * of the catalog leaves the session unbound and the message goes on. The
   * run holds its lease meanwhile, so a catalog that does not answer in
   * `CONTEXT_PROVIDER_TIMEOUT_MS` counts as a failure.
   */
  private async bindToPage(
    session: Session,
    input: { principal: Principal; page?: { entityRef?: string } },
  ): Promise<string | undefined> {
    const wanted = input.page?.entityRef;
    if (session.entityRef !== undefined || wanted === undefined) {
      return undefined;
    }
    const { items, sessions, entities, logger } = this.deps;
    try {
      const log = await items.read(session.id, { fromLatestSummary: true });
      if (log.length > 0) return undefined;
      const ref = await withTimeout(
        readableEntityRef(entities, wanted, input.principal),
        CONTEXT_PROVIDER_TIMEOUT_MS,
      );
      if (ref === undefined) return undefined;
      if (await sessions.bindEntityIfUnbound(session.id, ref)) return ref;
      return (await sessions.get(session.id)).entityRef;
    } catch (error) {
      logger?.warn(
        'AI chat could not bind the session to the entity of the page',
        {
          sessionId: session.id,
          ...errorLogFields(error),
        },
      );
      return undefined;
    }
  }
}

/** `promise`, or a rejection once `ms` passed first. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

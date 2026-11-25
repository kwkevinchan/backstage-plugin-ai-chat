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

import {
  assertOwner,
  ShuttingDown,
  type Principal,
  type QueuedMessage,
} from '../../domain';
import { abandonRun } from '../abandonRun';
import { buildRunRequest, type RunSettings } from '../buildRunRequest';
import type { ActivityNotifier } from '../notifyActivity';
import type { RunHandle, RunSupervisor } from '../RunSupervisor';
import type {
  AgentCatalog,
  AuditLog,
  Logger,
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
} from '../ports';
import type { Clock } from '@kwkevinchan/ai-chat-harness';

/**
 * Starts a run with the first message of the queue (IN-14). The queue sends
 * its next message with this when a run ended well, and `ResumeQueue` uses it
 * when the user presses "continue".
 */
export class StartNextQueued {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      queue: QueuedMessageRepository;
      supervisor: RunSupervisor;
      agents: AgentCatalog;
      audit: AuditLog;
      clock: Clock;
      settings: RunSettings;
      notify?: ActivityNotifier;
      logger?: Logger;
    },
  ) {}

  /**
   * The run runs with the credentials of `principal`. Returns `undefined`
   * when there is nothing to start: the queue is empty, or the session has a
   * run that has not ended (another start, or a message the user sent).
   * Throws `NotSessionOwner`, or `ShuttingDown` when this backend takes no new
   * loop; the queue is not changed then.
   *
   * The message leaves the queue and enters the log in one transaction
   * (`QueuedMessageRepository.startNext`), so it is sent once. When the loop
   * cannot be started after that, the run is ended as `not_started`; the
   * message is in the log, and the screen offers to send it again.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<{ run: RunHandle; message: QueuedMessage } | undefined> {
    const {
      sessions,
      runs,
      queue,
      supervisor,
      agents,
      audit,
      clock,
      settings,
    } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    if (!supervisor.accepting) throw new ShuttingDown();

    const started = await queue.startNext(session.id);
    if (!started) return undefined;
    const { run, message } = started;
    try {
      const request = await buildRunRequest(
        { agents, clock, settings },
        {
          session,
          run,
          principal: input.principal,
          ...(message.page && { page: message.page }),
        },
      );
      // No request of the user starts this run, so the event says whose
      // message it is. A failed record stops the run: no message is sent that
      // the audit log does not know.
      const span = await audit.begin({
        eventId: 'queued-message-send',
        actorRef: input.principal.userRef,
        sessionId: session.id,
        runId: run.id,
        queuedMessageId: message.id,
      });
      try {
        const handle = supervisor.launch(run, request);
        await span.success();
        return { run: handle, message };
      } catch (error) {
        await span.fail(error instanceof Error ? error.message : String(error));
        throw error;
      }
    } catch (error) {
      await abandonRun(runs, run, {
        notify: this.deps.notify,
        logger: this.deps.logger,
      });
      throw error;
    }
  }
}

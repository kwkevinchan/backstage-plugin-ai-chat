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

import type { Clock, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  assertOwner,
  ShuttingDown,
  type LeasedRun,
  type Principal,
} from '../../domain';
import { buildRunRequest, type RunSettings } from '../buildRunRequest';
import type { RunHandle, RunSupervisor } from '../RunSupervisor';
import type { AgentCatalog, RunRepository, SessionRepository } from '../ports';

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
      clock: Clock;
      settings: RunSettings;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `RunAlreadyActive` (H-03) or `ShuttingDown`.
   * The run comes first: the message of the user is written only once the
   * session has the run, so a message that the session cannot take (another
   * run is active) is not left in the log.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    text: string;
    page?: { path: string; entityRef?: string };
  }): Promise<RunHandle> {
    const { sessions, runs, items, supervisor, agents, clock, settings } =
      this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    if (!supervisor.accepting) throw new ShuttingDown();

    const run = await runs.start(session.id);
    try {
      const request = await buildRunRequest(
        { agents, clock, settings },
        { session, run, principal: input.principal, page: input.page },
      );
      await items.append(
        session.id,
        [{ kind: 'user_message', text: input.text }],
        run.fence,
      );
      return supervisor.launch(run, request);
    } catch (error) {
      await this.abandon(run);
      throw error;
    }
  }

  /** The run did not start the loop: end it, so the session is free again. */
  private async abandon(run: LeasedRun): Promise<void> {
    try {
      await this.deps.runs.transition(run.id, 'failed', {
        leaseOwner: run.fence.leaseOwner,
        endReason: 'not_started',
      });
    } catch {
      // The lease expiry (ExpireStaleRuns) ends it.
    }
  }
}

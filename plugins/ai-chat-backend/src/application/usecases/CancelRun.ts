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

import { InvalidRunTransition } from '@kwkevinchan/ai-chat-harness';
import { assertOwner, RunNotFound, type Principal } from '../../domain';
import { notifyActivity, type ActivityNotifier } from '../notifyActivity';
import type { RunSupervisor } from '../RunSupervisor';
import type { Logger, RunRepository, SessionRepository } from '../ports';

/** The user stops a run (H-06). The results that are stored stay. */
export class CancelRun {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      supervisor: RunSupervisor;
      notify?: ActivityNotifier;
      logger?: Logger;
    },
  ) {}

  /**
   * Asks the run to stop and returns at once. Returns `false` when the run
   * has ended already.
   *
   * The request is stored, so the backend that runs the loop sees it at its
   * next heartbeat. A loop in this process stops now. A run that waits for an
   * approval has no loop: it is cancelled here. A loop that finds the request
   * only after it wrote `waiting_approval` cancels the run itself
   * (`RunSupervisor`).
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    runId: string;
  }): Promise<boolean> {
    const { sessions, runs, supervisor } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const run = await runs.get(input.runId);
    if (run.sessionId !== session.id) throw new RunNotFound(input.runId);

    if (!(await runs.requestCancel(run.id))) return false;
    supervisor.cancel(run.id);
    // A loop that stopped now may still be writing `waiting_approval`: look at
    // the status after the request, whoever runs the loop.
    if ((await runs.get(run.id)).status === 'waiting_approval') {
      try {
        await runs.transition(run.id, 'cancelled', { endReason: 'user' });
        notifyActivity(this.deps.notify, this.deps.logger, session.id, 'idle');
      } catch (error) {
        // Ended in the meantime.
        if (!(error instanceof InvalidRunTransition)) throw error;
      }
    }
    return true;
  }
}

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

import { assertOwner, type Principal } from '../../domain';
import type { RunSettings } from '../buildRunRequest';
import type { ActivityNotifier } from '../notifyActivity';
import { resumeIfDecided } from '../resumeIfDecided';
import type { RunEnded } from '../runEnded';
import type { RunHandle, RunSupervisor } from '../RunSupervisor';
import type {
  AgentCatalog,
  Logger,
  RunRepository,
  SessionRepository,
} from '../ports';
import type { Clock, ItemLog } from '@kwkevinchan/ai-chat-harness';

/**
 * Carries on a run that waits for an approval although every call has a
 * decision: the request that made the last decision died before the loop
 * started (`SessionView.resumable`). It asks for no new decision. The loop
 * runs with the credentials of the caller.
 */
export class ResumeRun {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      supervisor: RunSupervisor;
      agents: AgentCatalog;
      clock: Clock;
      settings: RunSettings;
      notify?: ActivityNotifier;
      logger?: Logger;
      runEnded?: RunEnded;
    },
  ) {}

  /**
   * Returns the run when this request started the loop, and `undefined` when
   * there is nothing to carry on (no run, calls still wait for a decision, or
   * another request got there first). Throws `NotSessionOwner`, or
   * `ShuttingDown` when this backend takes no new loop.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    page?: { path: string; entityRef?: string };
  }): Promise<RunHandle | undefined> {
    const session = await this.deps.sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const run = await this.deps.runs.findActive(session.id);
    if (!run) return undefined;
    return resumeIfDecided(this.deps, {
      session,
      run,
      principal: input.principal,
      page: input.page,
    });
  }
}

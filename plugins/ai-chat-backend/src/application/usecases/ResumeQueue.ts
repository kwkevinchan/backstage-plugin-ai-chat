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
import type { RunHandle } from '../RunSupervisor';
import type { SessionRepository } from '../ports';
import type { StartNextQueued } from './StartNextQueued';

/**
 * The user presses "continue" on a queue that is paused (IN-15): the first
 * message of the queue starts a run with the credentials of this request. The
 * time the credentials have left is not checked: the user just acted, so the
 * credentials are fresh.
 */
export class ResumeQueue {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      startNext: Pick<StartNextQueued, 'execute'>;
    },
  ) {}

  /**
   * Returns the run, or `undefined` when there is nothing to send: the queue
   * is empty or a run is going on. Throws `NotSessionOwner`, or `ShuttingDown`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<RunHandle | undefined> {
    const { sessions, startNext } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const started = await startNext.execute({
      principal: input.principal,
      sessionId: session.id,
    });
    return started?.run;
  }
}

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

import { assertOwner, RunAlreadyActive, type Principal } from '../../domain';
import type { RunRepository, SessionRepository } from '../ports';

/**
 * Deletes a session of the signed-in user with its runs, items, queued
 * messages and images. A session with a run that has not ended is refused
 * (`RunAlreadyActive`). The delete locks that session's runs first and the
 * session row after them, the same order as an append, so the two wait
 * instead of deadlocking.
 */
export class DeleteSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
    },
  ) {}

  /** Throws `RunAlreadyActive` when a run has not ended. */
  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<void> {
    const { sessions, runs } = this.deps;
    assertOwner(await sessions.get(input.sessionId), input.principal);
    if (await runs.findActive(input.sessionId)) {
      throw new RunAlreadyActive(input.sessionId);
    }
    await sessions.delete(input.sessionId);
  }
}

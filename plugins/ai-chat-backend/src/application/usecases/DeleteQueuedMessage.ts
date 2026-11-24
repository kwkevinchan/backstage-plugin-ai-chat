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
import type { QueuedMessageRepository, SessionRepository } from '../ports';

/** The user removes a queued message that was not sent yet (IN-13). */
export class DeleteQueuedMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
    },
  ) {}

  /** Throws `NotSessionOwner` or `QueuedMessageNotFound`. */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    queuedId: string;
  }): Promise<void> {
    const { sessions, queue } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    await queue.remove(session.id, input.queuedId);
  }
}

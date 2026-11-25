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

import type { Item } from '@kwkevinchan/ai-chat-harness';
import { assertOwner, type Principal } from '../../domain';
import type { QueuedMessageRepository, SessionRepository } from '../ports';

/**
 * Moves a queued message into a running run as an inserted message (IN-20).
 * Atomic: either the message leaves the queue and is written to the log with
 * `delivery: inserted`, or nothing changes and an error is thrown.
 */
export class InsertQueuedMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      maxInsertsPerRun: number;
      maxImageBytesPerInput: number;
    },
  ) {}

  /**
   * Returns the item that was written. Throws `NotSessionOwner`,
   * `RunNotRunning` (the run waits for an approval, has ended, is another
   * run or has no live lease), `QueuedMessageNotFound` (already removed
   * or sent), `InsertLimitReached`, or `TooManyImageBytes`. A queued message
   * that was changed is inserted with its current content.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    queuedId: string;
    runId: string;
  }): Promise<Item> {
    const { sessions, queue, maxInsertsPerRun, maxImageBytesPerInput } =
      this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    return queue.insert(session.id, input.queuedId, input.runId, {
      maxInsertsPerRun,
      maxImageBytesPerInput,
    });
  }
}

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
import type {
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
} from '../ports';
import { queueViewOf, type QueueView } from './ListQueue';

/** The user sets the order of the queue (IN-13). */
export class ReorderQueue {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      runs: RunRepository;
    },
  ) {}

  /**
   * `ids` is the whole queue in the new order. Throws `NotSessionOwner`, or
   * `QueueChanged` when the queue is not the one the ids come from.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    ids: string[];
  }): Promise<QueueView> {
    const { sessions, queue } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    await queue.reorder(session.id, input.ids);
    return queueViewOf(this.deps, session.id);
  }
}

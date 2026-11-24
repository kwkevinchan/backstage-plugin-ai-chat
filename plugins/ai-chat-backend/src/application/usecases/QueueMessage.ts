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

import type { PageContext } from '@kwkevinchan/ai-chat-harness';
import { assertOwner, type Principal, type QueuedMessage } from '../../domain';
import type { QueuedMessageRepository, SessionRepository } from '../ports';

/** The user queues a message for when the run ends (IN-13). */
export class QueueMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      /** `aiChat.input.queue.maxMessages`. */
      maxMessages: number;
    },
  ) {}

  /** Throws `NotSessionOwner`, `NoActiveRun` or `QueueFull`. */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    text: string;
    page?: PageContext;
  }): Promise<QueuedMessage> {
    const { sessions, queue, maxMessages } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    return queue.add(
      session.id,
      {
        text: input.text,
        ...(input.page && { page: input.page }),
      },
      { max: maxMessages },
    );
  }
}

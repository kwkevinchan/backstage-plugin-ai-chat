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

import { assertOwner, type Principal, type QueuedMessage } from '../../domain';
import type {
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
} from '../ports';

/** The queue of a session, and whether it waits for the user. */
export type QueueView = { items: QueuedMessage[]; paused: boolean };

/**
 * The queue is paused when the session has no run that has not ended and the
 * queue is not empty (IN-15). Nothing is stored for it. A queue that the next
 * message is about to start from looks paused for a moment; the stream says
 * when a run follows.
 */
export async function queueViewOf(
  deps: { queue: QueuedMessageRepository; runs: RunRepository },
  sessionId: string,
): Promise<QueueView> {
  const items = await deps.queue.list(sessionId);
  if (items.length === 0) return { items, paused: false };
  return {
    items,
    paused: (await deps.runs.findActive(sessionId)) === undefined,
  };
}

/** The user reads the queue of a session (IN-15). */
export class ListQueue {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      runs: RunRepository;
    },
  ) {}

  /** Throws `NotSessionOwner`. */
  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<QueueView> {
    const session = await this.deps.sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    return queueViewOf(this.deps, session.id);
  }
}

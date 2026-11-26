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

import type { Item, PageContext } from '@kwkevinchan/ai-chat-harness';
import type { LeasedRun, QueuedMessage } from '../../domain';

/**
 * Where the queued messages are kept (IN-13, IN-14). Every change of the queue
 * of a session goes one after the other.
 */
export interface QueuedMessageRepository {
  /** The messages of the session, in the order they are sent. */
  list(sessionId: string): Promise<QueuedMessage[]>;

  /**
   * One transaction: the session has a run that has not ended (else
   * `NoActiveRun`), the queue has fewer than `max` messages (else `QueueFull`),
   * and the message goes to the end. The attachments are held for the message
   * (`reserved_by`), so the cleaning does not delete them; one that is not in
   * the session throws `UnknownAttachment`.
   */
  add(
    sessionId: string,
    input: { text: string; attachmentIds?: string[]; page?: PageContext },
    opts: { max: number },
  ): Promise<QueuedMessage>;

  /**
   * Throws `QueuedMessageNotFound`. `page: null` removes the page. A change of
   * `attachmentIds` releases the attachments that are no longer used and holds
   * the new ones.
   */
  update(
    sessionId: string,
    id: string,
    patch: {
      text?: string;
      attachmentIds?: string[];
      page?: PageContext | null;
    },
  ): Promise<QueuedMessage>;

  /** Throws `QueuedMessageNotFound`. Releases the attachments it held. */
  remove(sessionId: string, id: string): Promise<void>;

  /**
   * `ids` must be exactly the ids in the queue now, else `QueueChanged`. The
   * messages then have the positions 1, 2, 3 in the order of `ids`.
   */
  reorder(sessionId: string, ids: string[]): Promise<QueuedMessage[]>;

  /**
   * One transaction: starts a run, takes the first queued message out of the
   * queue and writes it as the first message of the run (`delivery: queued`).
   * The attachments of the message get `used_seq` in the same transaction.
   * Returns `undefined`, with nothing changed, when the queue is empty or the
   * session has a run that has not ended already. Throws `TooManyActiveRuns`,
   * with nothing changed, when the user has `runsPerUser` runs going on in
   * other sessions (P-05).
   */
  startNext(
    sessionId: string,
  ): Promise<{ run: LeasedRun; message: QueuedMessage } | undefined>;

  /**
   * One transaction: verifies `runId` belongs to the session, is `running`,
   * and has an unexpired lease (else `RunNotRunning`), removes `id` from the
   * queue (else `QueuedMessageNotFound`), checks insert limits, writes the
   * `user_message` with `delivery: 'inserted'`, and marks its attachments
   * used (keeping reservations for any other queued message that still lists
   * them). Remaining queued messages keep their order.
   */
  insert(
    sessionId: string,
    id: string,
    runId: string,
    opts?: { maxInsertsPerRun?: number; maxImageBytesPerInput?: number },
  ): Promise<Item>;
}

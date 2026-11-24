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

import type { AttachmentMeta } from '../../domain';

/**
 * Where the images of the sessions are kept (D-27). The bytes sit behind this
 * port, so they can move to an object store without a change in the use cases.
 */
export interface AttachmentStore {
  /**
   * Stores an image. When the session has `maxPending` images that are in no
   * message yet, throws `TooManyPendingAttachments`. The adapter computes the
   * `sha256`.
   */
  put(input: {
    sessionId: string;
    ownerRef: string;
    mediaType: AttachmentMeta['mediaType'];
    name: string;
    bytes: Uint8Array;
    maxPending: number;
  }): Promise<AttachmentMeta>;

  /** Throws `AttachmentNotFound`: there is none, or it is in another session. */
  get(
    sessionId: string,
    id: string,
  ): Promise<{ meta: AttachmentMeta; bytes: Uint8Array }>;

  /** Throws `AttachmentNotFound` when one of the ids is not in the session; no bytes are read. */
  describe(sessionId: string, ids: string[]): Promise<AttachmentMeta[]>;

  /**
   * Copies images into another session, for the copy of a shared session:
   * new ids, the new `sessionId`, `ownerRef` is the one who copies, the bytes
   * are copied. Returns the new meta by the old id; an id that cannot be read
   * is left out. The copies do not count for `maxPending`: they enter a message
   * at once.
   */
  copy(input: {
    fromSessionId: string;
    toSessionId: string;
    ownerRef: string;
    ids: string[];
  }): Promise<Map<string, AttachmentMeta>>;

  /**
   * Deletes the images that are in no message, are not held by a queued
   * message, and were stored before `olderThan`. Returns how many.
   */
  purgeUnused(olderThan: Date): Promise<number>;
}

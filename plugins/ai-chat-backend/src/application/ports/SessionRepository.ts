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

import type { NewSession, Session, SessionPatch } from '../../domain';

/** Where the sessions are kept. */
export interface SessionRepository {
  /** Makes a session with a new id and an empty log. */
  create(input: NewSession): Promise<Session>;

  /** Throws `SessionNotFound` when there is none. */
  get(sessionId: string): Promise<Session>;

  /**
   * The sessions of an owner. Pinned ones come first, then the most recently
   * updated, then `id`. Archived ones are left out unless `includeArchived`
   * is set. `query` keeps the sessions whose title contains it, with both
   * sides of the match passed through SQL `lower()`. A session with no title
   * is left out. `%` and `_` match themselves.
   */
  listByOwner(
    ownerRef: string,
    opts?: { includeArchived?: boolean; limit?: number; query?: string },
  ): Promise<Session[]>;

  /** Throws `SessionNotFound` when there is none. */
  update(sessionId: string, patch: SessionPatch): Promise<Session>;

  /**
   * Sets the title only while it is still empty, so a title the user set in
   * the meantime is kept. Returns whether this call wrote it. A session that
   * does not exist returns false.
   */
  setTitleIfAbsent(sessionId: string, title: string): Promise<boolean>;

  /** Deletes the session with its runs and items. Throws `SessionNotFound` when there is none. */
  delete(sessionId: string): Promise<void>;

  /**
   * Deletes sessions whose last change is strictly before `olderThan`, except
   * a session with a run that has not ended. Returns how many were deleted.
   * On PostgreSQL, a row another transaction holds is skipped, so two calls
   * at the same time do not delete one session twice and do not wait on each
   * other.
   */
  purgeExpired(olderThan: Date): Promise<number>;
}

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

import type { NewShare, Share, ShareScope } from '../../domain';

/** Where the shares of a session are kept. */
export interface ShareRepository {
  /** Inserts one share. It is not cancelled. */
  add(input: NewShare): Promise<Share>;

  /** One share of the session, cancelled or not; `undefined` when there is none. */
  get(sessionId: string, shareId: string): Promise<Share | undefined>;

  /**
   * Sets both seq fields (an absent one becomes null) and, when given,
   * `expiresAt`, in one statement that matches only a share that is not
   * cancelled. Returns the share as stored, or `undefined` when it is
   * cancelled or missing, so a cancel that came first is never undone.
   */
  update(
    sessionId: string,
    shareId: string,
    change: ShareScope & { expiresAt?: string },
  ): Promise<Share | undefined>;

  /**
   * Cancels a share that is not cancelled yet. Returns it, or `undefined`
   * when it was cancelled already or is missing: of two cancels at the same
   * time, one gets the share.
   */
  revoke(sessionId: string, shareId: string): Promise<Share | undefined>;

  /** Every share of the session, cancelled ones included, oldest first. */
  listBySession(sessionId: string): Promise<Share[]>;

  /**
   * The shares of the session that are not cancelled and whose subject is one
   * of `subjectRefs`. An empty list matches nothing.
   */
  listActiveFor(
    sessionId: string,
    subjectRefs: readonly string[],
  ): Promise<Share[]>;
}

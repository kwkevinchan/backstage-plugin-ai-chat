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

import type { NewShare, Share } from '../../domain';

/** Where the shares of a session are kept. Creating and cancelling them is later. */
export interface ShareRepository {
  /** Inserts one share. It is not cancelled. */
  add(input: NewShare): Promise<Share>;

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

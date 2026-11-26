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

import type { Item, ItemBody, PlanUpdateItem } from '../../domain';

/**
 * What the loop asks the log to write. The log adds the session id, the
 * sequence number, the run id (from the fence) and the time.
 *
 * @public
 */
export type ItemDraft = ItemBody;

/**
 * Proof that the writer holds the lease of a run. The log refuses a write
 * when the lease is not held (a write by a run that lost its lease would
 * corrupt the session).
 *
 * @public
 */
export type RunFence = {
  runId: string;
  leaseOwner: string;
};

/**
 * The log of one session: items in the order of their sequence numbers,
 * never changed after they are written (D-17). `itemLogContract` is the test
 * every implementation passes (A-10).
 *
 * @public
 */
export interface ItemLog {
  /**
   * The items of the session in order of `seq`.
   *
   * - With `afterSeq`, only those with a larger `seq`.
   * - With `fromLatestSummary`, only the items after what the newest `summary`
   *   covers (`seq` larger than its `coversUpToSeq`), which includes the
   *   summary itself. A session with no summary gives all its items. This is
   *   how the loop keeps the read short for a long session. With both options
   *   the larger bound counts.
   */
  read(
    sessionId: string,
    opts?: { afterSeq?: number; fromLatestSummary?: boolean },
  ): Promise<Item[]>;

  /**
   * The last `plan_update` item of the session, whatever a `summary` covers;
   * `undefined` when the session has none. Its plan is the current plan (X-06).
   */
  latestPlanUpdate(sessionId: string): Promise<PlanUpdateItem | undefined>;

  /**
   * Writes all drafts in one step, with consecutive sequence numbers starting
   * after the last item of the session (the first item of a session has `seq`
   * 1). Returns the items written, in order.
   *
   * - Throws `DuplicateItem` when a draft has the same `dedupeKeyOf` as an
   *   item already in the log, or as another draft of the same call. Nothing
   *   of the call is written then.
   * - Throws `LeaseLost` when the fence is not the lease holder of its run.
   *   Nothing is written then.
   */
  append(
    sessionId: string,
    drafts: ItemDraft[],
    fence: RunFence,
  ): Promise<Item[]>;
}

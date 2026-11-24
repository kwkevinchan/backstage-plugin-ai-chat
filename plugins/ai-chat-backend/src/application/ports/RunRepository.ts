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

import type { RunControl, RunStatus } from '@kwkevinchan/ai-chat-harness';
import type { LeasedRun, Run } from '../../domain';

/** The statuses a run changes to without taking the lease. */
export type RunTransitionTarget = Exclude<RunStatus, 'running'>;

/**
 * Where the runs are kept: creation, the lease, and the status changes. It
 * is also the `RunControl` of the core loop (heartbeat and usage).
 */
export interface RunRepository extends RunControl {
  /**
   * Makes a run in `running` that this backend holds the lease of. Throws
   * `RunAlreadyActive` when the session has a run that has not ended (H-03):
   * of any number of calls at the same time for one session, one succeeds.
   */
  start(sessionId: string, opts?: { parentRunId?: string }): Promise<LeasedRun>;

  /** Throws `RunNotFound` when there is none. */
  get(runId: string): Promise<Run>;

  /** The run of the session that has not ended, if any. */
  findActive(sessionId: string): Promise<Run | undefined>;

  /**
   * Takes the lease of a run to carry it on: a run that waits for an approval
   * (it becomes `running`), or a running run whose lease is free or expired.
   * Each lease has its own fence: the one a run had before stops working, also
   * when the same backend takes the run again. Returns `undefined` when the
   * run has ended or a live lease is held (by anyone, the caller included).
   * Of several callers at the same time, one gets the run.
   */
  acquireLease(runId: string): Promise<LeasedRun | undefined>;

  /**
   * Changes the status of a run. With `leaseOwner` the run must be held by
   * that owner (else `LeaseLost`); without it the caller is the host acting
   * for the user, for example to cancel a run that waits for an approval.
   * Throws `InvalidRunTransition` when the change is not allowed. A run that
   * ends, or waits for an approval, has no lease and (when it ends) no
   * active session any more.
   *
   * With `requireAllRead` the change is refused with `UnreadMessages`, and the
   * run stays as it is, when a message was inserted that the model has not
   * read (IN-11). The check and the change are one transaction on the run, and
   * an insert holds the same row, so each of the two comes first and the other
   * sees it.
   */
  transition(
    runId: string,
    to: RunTransitionTarget,
    opts?: {
      leaseOwner?: string;
      endReason?: string;
      requireAllRead?: boolean;
    },
  ): Promise<Run>;

  /** Asks the loop to stop. Returns `false` when the run has ended. */
  requestCancel(runId: string): Promise<boolean>;

  /**
   * Marks running runs whose lease has expired as `expired` (H-04). Returns
   * their ids.
   */
  expireStale(): Promise<string[]>;
}

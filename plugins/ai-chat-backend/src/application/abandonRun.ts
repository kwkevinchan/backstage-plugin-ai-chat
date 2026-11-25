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

import { notifyActivity, type ActivityNotifier } from './notifyActivity';
import type { Logger, RunRepository } from './ports';
import type { LeasedRun } from '../domain';

/** The run did not start the loop: end it, so the session is free again. */
export async function abandonRun(
  runs: RunRepository,
  run: LeasedRun,
  notifier?: { notify?: ActivityNotifier; logger?: Logger },
): Promise<void> {
  try {
    await runs.transition(run.id, 'failed', {
      leaseOwner: run.fence.leaseOwner,
      endReason: 'not_started',
    });
    notifyActivity(notifier?.notify, notifier?.logger, run.sessionId, 'idle');
  } catch {
    // The lease expiry (ExpireStaleRuns) ends it.
  }
}

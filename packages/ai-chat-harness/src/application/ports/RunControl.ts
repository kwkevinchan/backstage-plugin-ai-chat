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

import type { RunUsage } from '../../domain';
import type { RunFence } from './ItemLog';

/**
 * What the loop needs from the run record of the host.
 *
 * @public
 */
export interface RunControl {
  /**
   * Renews the lease and tells whether the user asked to stop. Throws
   * `LeaseLost` when the lease is not held any more.
   */
  heartbeat(fence: RunFence): Promise<{ cancelRequested: boolean }>;
  /**
   * Stores what the run has used. The host keeps it with the run, so the
   * next call of the loop for the same run (after an approval) starts from
   * it.
   */
  recordUsage(fence: RunFence, usage: RunUsage): Promise<void>;
}

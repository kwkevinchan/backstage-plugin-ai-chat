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

import type { Logger, RunRepository } from '../ports';

/**
 * Marks the runs whose lease expired as `expired` (H-04): the backend that
 * ran them stopped. The session can start a new run then.
 */
export class ExpireStaleRuns {
  constructor(private readonly deps: { runs: RunRepository; logger: Logger }) {}

  /** Returns the ids of the runs that were marked. */
  async execute(): Promise<string[]> {
    const ids = await this.deps.runs.expireStale();
    if (ids.length > 0) {
      this.deps.logger.warn(
        `Marked ${ids.length} run(s) expired: the lease was not renewed`,
        { runIds: ids },
      );
    }
    return ids;
  }
}

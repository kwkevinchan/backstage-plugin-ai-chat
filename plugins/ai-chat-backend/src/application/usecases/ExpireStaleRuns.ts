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

import type { Run } from '../../domain';
import { notifyActivity, type ActivityNotifier } from '../notifyActivity';
import type { RunEnded } from '../runEnded';
import type { Logger, RunRepository, SessionRepository } from '../ports';

/**
 * Marks the runs whose lease expired as `expired` (H-04): the backend that
 * ran them stopped. The session can start a new run then.
 *
 * Afterwards, in the background, it tells the owner of each session, and the
 * `onRunEnd` hooks of each run. `expireStale` returns a run only to the call
 * that changed it (on PostgreSQL the `UPDATE` of a second backend waits for
 * the row and then finds it no longer `running`), so the hooks run once, on
 * one backend.
 */
export class ExpireStaleRuns {
  constructor(
    private readonly deps: {
      runs: RunRepository;
      logger: Logger;
      notify?: ActivityNotifier;
      sessions?: Pick<SessionRepository, 'get'>;
      runEnded?: RunEnded;
    },
  ) {}

  /** Returns the ids of the runs that were marked. */
  async execute(): Promise<string[]> {
    const ids = await this.deps.runs.expireStale();
    if (ids.length > 0) {
      this.deps.logger.warn(
        `Marked ${ids.length} run(s) expired: the lease was not renewed`,
        { runIds: ids },
      );
      if (this.deps.notify || this.deps.runEnded) void this.afterExpiry(ids);
    }
    return ids;
  }

  private async afterExpiry(ids: string[]): Promise<void> {
    const { notify, logger } = this.deps;
    const results = await Promise.allSettled(
      ids.map(id => this.deps.runs.get(id)),
    );
    const seen = new Set<string>();
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn(
          'Could not notify the activity of a session',
          result.reason instanceof Error
            ? result.reason
            : { error: String(result.reason) },
        );
        continue;
      }
      const run = result.value;
      if (notify && !seen.has(run.sessionId)) {
        seen.add(run.sessionId);
        notifyActivity(notify, logger, run.sessionId, 'idle');
      }
      await this.tellHooks(run);
    }
  }

  private async tellHooks(run: Run): Promise<void> {
    const { sessions, runEnded, logger } = this.deps;
    if (!sessions || !runEnded) return;
    try {
      const session = await sessions.get(run.sessionId);
      runEnded({ run, agentId: session.agentId, userRef: session.ownerRef });
    } catch (error) {
      logger.warn('Could not tell the onRunEnd hooks about an expired run', {
        runId: run.id,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}

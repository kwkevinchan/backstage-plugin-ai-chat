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

import type { RunOutcome } from '@kwkevinchan/ai-chat-harness';
import {
  canAutoStart,
  isNormalEnd,
  TooManyActiveRuns,
  type Principal,
  type Run,
} from '../domain';
import type { Clock } from '@kwkevinchan/ai-chat-harness';
import type { AfterRun, QueueState } from './hostEvents';
import type { Logger, QueuedMessageRepository } from './ports';
import type { RunSupervisor } from './RunSupervisor';
import type { RunSettings } from './buildRunRequest';
import type { StartNextQueued } from './usecases/StartNextQueued';

/**
 * What happens to the queue when a run left the loop (IN-14, IN-15, IN-16).
 * The first rule that applies wins:
 *
 * 1. The run waits for an approval: it has not ended; nothing is sent.
 * 2. The queue is empty: nothing to do.
 * 3. The run did not end the normal way (a failure, a stop, an expiry, or a
 *    limit): the queue is paused.
 * 4. The credentials do not last for another run (IN-16): paused.
 * 5. This backend is shutting down: paused.
 * 6. The first message starts a run with the credentials of the run that
 *    ended. When the queue was emptied or the user started a run first,
 *    nothing starts.
 * 7. The user has as many runs going on as `runsPerUser` allows: paused,
 *    with no reason and nothing logged.
 * 8. An error is logged and counts as a pause. The run that ended is not
 *    affected.
 */
export function createAfterRun(deps: {
  queue: QueuedMessageRepository;
  startNext: Pick<StartNextQueued, 'execute'>;
  supervisor: Pick<RunSupervisor, 'accepting'>;
  clock: Clock;
  settings: RunSettings;
  logger: Logger;
}): AfterRun {
  const { queue, startNext, supervisor, clock, settings, logger } = deps;

  async function decide(
    run: Run,
    outcome: RunOutcome,
    principal: Principal,
  ): Promise<QueueState> {
    const items = await queue.list(run.sessionId);
    if (outcome.status === 'waiting_approval') return { items, paused: false };
    if (items.length === 0) return { items, paused: false };
    if (!isNormalEnd(outcome)) {
      return { items, paused: true, pausedReason: 'run_not_completed' };
    }
    if (!canAutoStart(principal, settings.limits, clock.now())) {
      return { items, paused: true, pausedReason: 'credentials' };
    }
    if (!supervisor.accepting) {
      return { items, paused: true, pausedReason: 'shutting_down' };
    }
    let started: Awaited<ReturnType<typeof startNext.execute>>;
    try {
      started = await startNext.execute({
        principal,
        sessionId: run.sessionId,
      });
    } catch (error) {
      // The user has as many runs as allowed in other sessions (P-05): the
      // queue waits, and the user can continue it later.
      if (error instanceof TooManyActiveRuns) return { items, paused: true };
      throw error;
    }
    if (!started)
      return { items: await queue.list(run.sessionId), paused: false };
    // Nobody reads the events of the new run here: the screen joins it with
    // the stream route. Leaving the subscription frees what it holds.
    await started.run.events[Symbol.asyncIterator]().return?.();
    return {
      items: await queue.list(run.sessionId),
      paused: false,
      nextRunId: started.run.runId,
    };
  }

  return async info => {
    try {
      return await decide(info.run, info.outcome, info.principal);
    } catch (error) {
      logger.error('The queue could not send its next message', {
        sessionId: info.run.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { items: await queue.list(info.run.sessionId), paused: true };
    }
  };
}

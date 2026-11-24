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

import type { Clock, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  callsAwaitingDecision,
  ShuttingDown,
  type Principal,
  type Run,
  type Session,
} from '../domain';
import { buildRunRequest, type RunSettings } from './buildRunRequest';
import type { RunHandle, RunSupervisor } from './RunSupervisor';
import type { AgentCatalog, RunRepository } from './ports';

/**
 * Carries a run on when it waits for an approval and every call that needs one
 * has a decision. Of any number of callers at the same time (any backend), the
 * one that gets the lease starts the loop; the others get `undefined`, as does
 * a caller whose run still has calls to decide.
 *
 * Throws `ShuttingDown` when this backend takes no new loop: the decisions are
 * stored and the run stays `waiting_approval`, so another backend can carry it
 * on. The loop uses the credentials of `principal`.
 */
export async function resumeIfDecided(
  deps: {
    runs: RunRepository;
    items: ItemLog;
    supervisor: RunSupervisor;
    agents: AgentCatalog;
    clock: Clock;
    settings: RunSettings;
  },
  input: {
    session: Session;
    run: Run;
    principal: Principal;
    page?: { path: string; entityRef?: string };
  },
): Promise<RunHandle | undefined> {
  const { runs, items, supervisor, agents, clock, settings } = deps;
  const { session, run, principal, page } = input;
  if (run.status !== 'waiting_approval') return undefined;
  const log = await items.read(session.id);
  if (callsAwaitingDecision(log, run.id).length > 0) return undefined;
  if (!supervisor.accepting) throw new ShuttingDown();

  const leased = await runs.acquireLease(run.id);
  if (!leased) return undefined;
  try {
    const request = await buildRunRequest(
      { agents, clock, settings },
      { session, run: leased, principal, page },
    );
    return supervisor.launch(leased, request);
  } catch (error) {
    try {
      if (error instanceof ShuttingDown) {
        // Not a failure of the run: put it back, every decision stays.
        await runs.transition(leased.id, 'waiting_approval', {
          leaseOwner: leased.fence.leaseOwner,
        });
      } else {
        await runs.transition(leased.id, 'failed', {
          leaseOwner: leased.fence.leaseOwner,
          endReason: 'not_started',
        });
      }
    } catch {
      // The lease expiry (ExpireStaleRuns) ends it.
    }
    throw error;
  }
}

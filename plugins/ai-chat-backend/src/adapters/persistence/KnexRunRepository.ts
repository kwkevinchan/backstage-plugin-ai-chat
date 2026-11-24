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

import {
  LeaseLost,
  assertTransition,
  isActiveStatus,
  type Clock,
  type IdGenerator,
  type RunFence,
  type RunStatus,
  type RunUsage,
} from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import type {
  RunRepository,
  RunTransitionTarget,
} from '../../application/ports';
import {
  RunAlreadyActive,
  RunNotFound,
  type LeasedRun,
  type Run,
} from '../../domain';
import { isUniqueViolation } from './uniqueViolation';

type RunRow = {
  id: string;
  session_id: string;
  parent_run_id: string | null;
  status: RunStatus;
  active_session_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  steps_used: number;
  tool_calls_used: number;
  elapsed_seconds: number;
  cancel_requested: boolean | number;
  end_reason: string | null;
  started_at: string;
  ended_at: string | null;
};

const ACTIVE: RunStatus[] = ['running', 'waiting_approval'];

/**
 * The runs in the `runs` table. It also is the `RunControl` of the loop.
 *
 * - One active run per session (H-03): `active_session_id` holds the session
 *   id while the run is active and is null after, and a unique index on it
 *   refuses a second active run.
 * - The lease: `lease_owner` and `lease_expires_at`. Every `start` and every
 *   `acquireLease` makes a new owner value with the `IdGenerator`, so each
 *   lease has its own fence, also when the same backend takes the same run
 *   again. Taking a lease is one UPDATE with the condition in its WHERE, so
 *   the database decides between callers at the same time.
 */
export class KnexRunRepository implements RunRepository {
  private readonly leaseSeconds: number;

  /**
   * @param options.leaseSeconds - How long a lease or a heartbeat lasts. 30
   * by default.
   */
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: { leaseSeconds?: number } = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
  }

  async start(
    sessionId: string,
    opts: { parentRunId?: string } = {},
  ): Promise<LeasedRun> {
    const now = this.clock.now();
    const row: RunRow = {
      id: this.ids.next(),
      session_id: sessionId,
      parent_run_id: opts.parentRunId ?? null,
      status: 'running',
      active_session_id: sessionId,
      lease_owner: this.ids.next(),
      lease_expires_at: this.leaseEnd(now),
      steps_used: 0,
      tool_calls_used: 0,
      elapsed_seconds: 0,
      cancel_requested: false,
      end_reason: null,
      started_at: now.toISOString(),
      ended_at: null,
    };
    try {
      await this.knex('runs').insert(row);
    } catch (error) {
      if (isUniqueViolation(error, 'active_session_id')) {
        throw new RunAlreadyActive(sessionId);
      }
      throw error;
    }
    return this.leased(toRun(row));
  }

  async get(runId: string): Promise<Run> {
    const row = await this.knex<RunRow>('runs').where({ id: runId }).first();
    if (!row) throw new RunNotFound(runId);
    return toRun(row);
  }

  async findActive(sessionId: string): Promise<Run | undefined> {
    const row = await this.knex<RunRow>('runs')
      .where({ active_session_id: sessionId })
      .first();
    return row ? toRun(row) : undefined;
  }

  async acquireLease(runId: string): Promise<LeasedRun | undefined> {
    const now = this.clock.now();
    const [row] = await this.knex<RunRow>('runs')
      .where({ id: runId })
      .whereIn('status', ACTIVE)
      .andWhere(builder =>
        builder
          .where('status', 'waiting_approval')
          .orWhereNull('lease_owner')
          .orWhere('lease_expires_at', '<', now.toISOString()),
      )
      .update({
        status: 'running',
        lease_owner: this.ids.next(),
        lease_expires_at: this.leaseEnd(now),
      })
      .returning('*');
    return row ? this.leased(toRun(row)) : undefined;
  }

  async heartbeat(fence: RunFence): Promise<{ cancelRequested: boolean }> {
    const [row] = await this.held(fence)
      .update({ lease_expires_at: this.leaseEnd(this.clock.now()) })
      .returning('cancel_requested');
    if (!row) throw new LeaseLost(fence.runId);
    return { cancelRequested: Boolean(row.cancel_requested) };
  }

  async recordUsage(fence: RunFence, usage: RunUsage): Promise<void> {
    const count = await this.held(fence).update({
      steps_used: usage.stepsUsed,
      tool_calls_used: usage.toolCallsUsed,
      elapsed_seconds: usage.elapsedSeconds,
    });
    if (count === 0) throw new LeaseLost(fence.runId);
  }

  async transition(
    runId: string,
    to: RunTransitionTarget,
    opts: { leaseOwner?: string; endReason?: string } = {},
  ): Promise<Run> {
    return this.knex.transaction(async trx => {
      const row = await trx<RunRow>('runs')
        .where({ id: runId })
        .forUpdate()
        .first();
      if (!row) throw new RunNotFound(runId);
      if (
        opts.leaseOwner !== undefined &&
        row.lease_owner !== opts.leaseOwner
      ) {
        throw new LeaseLost(runId);
      }
      assertTransition(row.status, to);
      const changes: Partial<RunRow> = {
        status: to,
        lease_owner: null,
        lease_expires_at: null,
      };
      if (!isActiveStatus(to)) {
        changes.active_session_id = null;
        changes.ended_at = this.clock.now().toISOString();
        changes.end_reason = opts.endReason ?? null;
      }
      await trx('runs').where({ id: runId }).update(changes);
      return toRun({ ...row, ...changes });
    });
  }

  async requestCancel(runId: string): Promise<boolean> {
    const count = await this.knex('runs')
      .where({ id: runId })
      .whereIn('status', ACTIVE)
      .update({ cancel_requested: true });
    return count > 0;
  }

  async expireStale(): Promise<string[]> {
    const now = this.clock.now().toISOString();
    const rows = await this.knex('runs')
      .where({ status: 'running' })
      .andWhere('lease_expires_at', '<', now)
      .update({
        status: 'expired',
        active_session_id: null,
        lease_owner: null,
        lease_expires_at: null,
        ended_at: now,
        end_reason: 'lease_expired',
      })
      .returning('id');
    return rows.map(row => row.id);
  }

  /** The run of the fence, if its owner holds the lease and it is running. */
  private held(fence: RunFence) {
    return this.knex('runs').where({
      id: fence.runId,
      status: 'running',
      lease_owner: fence.leaseOwner,
    });
  }

  private leaseEnd(from: Date): string {
    return new Date(from.getTime() + this.leaseSeconds * 1000).toISOString();
  }

  private leased(run: Run): LeasedRun {
    if (run.leaseOwner === undefined) {
      throw new Error(`Run ${run.id} has no lease owner`);
    }
    return { ...run, fence: { runId: run.id, leaseOwner: run.leaseOwner } };
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.parent_run_id !== null && { parentRunId: row.parent_run_id }),
    status: row.status,
    ...(row.lease_owner !== null && { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at !== null && {
      leaseExpiresAt: row.lease_expires_at,
    }),
    usage: {
      stepsUsed: row.steps_used,
      toolCallsUsed: row.tool_calls_used,
      elapsedSeconds: row.elapsed_seconds,
    },
    cancelRequested: Boolean(row.cancel_requested),
    ...(row.end_reason !== null && { endReason: row.end_reason }),
    startedAt: row.started_at,
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
  };
}

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
  UnreadMessages,
  type LeasedRun,
  type Run,
} from '../../domain';
import {
  leased,
  leaseEnd,
  newRunRow,
  toRun,
  type RunRow,
} from './transactions';
import { isUniqueViolation } from './uniqueViolation';

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
    const row = newRunRow(this.timing(), sessionId, opts.parentRunId);
    try {
      await this.knex('runs').insert(row);
    } catch (error) {
      if (isUniqueViolation(error, 'active_session_id')) {
        throw new RunAlreadyActive(sessionId);
      }
      throw error;
    }
    return leased(toRun(row));
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

  async findActiveForSessions(sessionIds: readonly string[]): Promise<Run[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.knex<RunRow>('runs').whereIn('active_session_id', [
      ...sessionIds,
    ]);
    return rows.map(row => toRun(row));
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
        lease_expires_at: leaseEnd(now, this.leaseSeconds),
      })
      .returning('*');
    return row ? leased(toRun(row)) : undefined;
  }

  async heartbeat(fence: RunFence): Promise<{ cancelRequested: boolean }> {
    const [row] = await this.held(fence)
      .update({
        lease_expires_at: leaseEnd(this.clock.now(), this.leaseSeconds),
      })
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
    opts: {
      leaseOwner?: string;
      endReason?: string;
      requireAllRead?: boolean;
    } = {},
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
      if (opts.requireAllRead) {
        // A query of its own, after the lock: it sees what an insert that held
        // the row before us committed (READ COMMITTED takes a snapshot for each
        // statement).
        const unread = await trx('items')
          .where({ session_id: row.session_id, run_id: runId })
          .andWhere({ kind: 'user_message' })
          .andWhere('seq', '>', row.read_up_to_seq)
          .first('seq');
        if (unread) throw new UnreadMessages(runId);
      }
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

  private timing() {
    return {
      clock: this.clock,
      ids: this.ids,
      leaseSeconds: this.leaseSeconds,
    };
  }
}

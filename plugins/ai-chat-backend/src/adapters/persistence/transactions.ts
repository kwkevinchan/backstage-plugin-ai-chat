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
  DuplicateItem,
  type Clock,
  type IdGenerator,
  type Item,
  type ItemDraft,
  type RunStatus,
} from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import type { LeasedRun, Run } from '../../domain';

/*
 * The steps that more than one repository takes inside a transaction: a run
 * starts in `KnexRunRepository` and in `KnexQueuedMessageRepository.startNext`,
 * and items are written by `KnexItemLog.append` and by `startNext`. A
 * transaction that needs a run takes it first, and with the strongest lock it
 * will need (never a shared lock that it raises later). Then it takes the row
 * of the session (`UPDATE`, or `FOR NO KEY UPDATE`): a transaction that
 * touches `sessions`, `items` or `queued_messages` holds that row, so those
 * transactions of one session go one after the other and none waits for a
 * table while another holds it (architecture, "Database").
 */

export type RunRow = {
  id: string;
  session_id: string;
  parent_run_id: string | null;
  status: RunStatus;
  active_session_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  steps_used: number;
  tool_calls_used: number;
  read_up_to_seq: number;
  elapsed_seconds: number;
  cancel_requested: boolean | number;
  end_reason: string | null;
  started_at: string;
  ended_at: string | null;
};

export type ItemRow = {
  session_id: string;
  seq: number;
  run_id: string | null;
  kind: string;
  payload: string;
  dedupe_key: string | null;
  created_at: string;
};

/** The row of a new run: `running`, active in its session, with a lease. */
export function newRunRow(
  deps: { clock: Clock; ids: IdGenerator; leaseSeconds: number },
  sessionId: string,
  parentRunId?: string,
): RunRow {
  const now = deps.clock.now();
  return {
    id: deps.ids.next(),
    session_id: sessionId,
    parent_run_id: parentRunId ?? null,
    status: 'running',
    active_session_id: sessionId,
    lease_owner: deps.ids.next(),
    lease_expires_at: leaseEnd(now, deps.leaseSeconds),
    steps_used: 0,
    tool_calls_used: 0,
    read_up_to_seq: 0,
    elapsed_seconds: 0,
    cancel_requested: false,
    end_reason: null,
    started_at: now.toISOString(),
    ended_at: null,
  };
}

export function leaseEnd(from: Date, leaseSeconds: number): string {
  return new Date(from.getTime() + leaseSeconds * 1000).toISOString();
}

/**
 * Adds `count` to `sessions.next_seq` in one UPDATE and returns the first
 * number of the batch. The UPDATE locks the row of the session, so the writes
 * to one session go one after the other and take consecutive numbers; a
 * rolled back transaction gives its numbers back.
 */
export async function reserveSeq(
  trx: Knex.Transaction,
  sessionId: string,
  count: number,
): Promise<number> {
  const [{ next_seq: nextSeq }] = await trx('sessions')
    .where({ id: sessionId })
    .update({ next_seq: trx.raw('next_seq + ?', [count]) })
    .returning('next_seq');
  return nextSeq - count;
}

/**
 * Writes the drafts from `firstSeq` on, in the transaction of the caller.
 * Refuses a key that is in the log already, or twice in the batch
 * (`DuplicateItem`).
 */
export async function writeItems(
  trx: Knex.Transaction,
  clock: Clock,
  input: {
    sessionId: string;
    runId: string;
    firstSeq: number;
    drafts: ItemDraft[];
    keys: (string | undefined)[];
  },
): Promise<Item[]> {
  const { sessionId, runId, firstSeq, drafts, keys } = input;
  await refuseDuplicates(trx, sessionId, keys);
  const createdAt = clock.now().toISOString();
  const rows: ItemRow[] = drafts.map((draft, index) => {
    const { kind, ...rest } = draft;
    return {
      session_id: sessionId,
      seq: firstSeq + index,
      run_id: runId,
      kind,
      payload: JSON.stringify(rest),
      dedupe_key: keys[index] ?? null,
      created_at: createdAt,
    };
  });
  await trx('items').insert(rows);
  await trx('sessions')
    .where({ id: sessionId })
    .update({ updated_at: createdAt });
  return rows.map(toItem);
}

async function refuseDuplicates(
  trx: Knex.Transaction,
  sessionId: string,
  keys: (string | undefined)[],
): Promise<void> {
  const wanted = keys.filter((key): key is string => key !== undefined);
  const seen = new Set<string>();
  for (const key of wanted) {
    if (seen.has(key)) throw new DuplicateItem(key);
    seen.add(key);
  }
  if (wanted.length === 0) return;
  const existing = await trx('items')
    .where({ session_id: sessionId })
    .whereIn('dedupe_key', wanted)
    .first<{ dedupe_key: string }>('dedupe_key');
  if (existing) throw new DuplicateItem(existing.dedupe_key);
}

export function toItem(row: ItemRow): Item {
  return {
    ...JSON.parse(row.payload),
    kind: row.kind,
    sessionId: row.session_id,
    seq: row.seq,
    ...(row.run_id !== null && { runId: row.run_id }),
    createdAt: row.created_at,
  } as Item;
}

export function toRun(row: RunRow): Run {
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

export function leased(run: Run): LeasedRun {
  if (run.leaseOwner === undefined) {
    throw new Error(`Run ${run.id} has no lease owner`);
  }
  return { ...run, fence: { runId: run.id, leaseOwner: run.leaseOwner } };
}

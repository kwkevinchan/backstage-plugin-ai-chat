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
  type AttachmentRef,
  type Clock,
  type IdGenerator,
  type Item,
  type ItemDraft,
  type RunStatus,
} from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import { isPostgres } from './postgres';
import {
  InsertLimitReached,
  TooManyActiveRuns,
  TooManyImageBytes,
  UnknownAttachment,
  type AttachmentMeta,
  type LeasedRun,
  type Run,
} from '../../domain';

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

/** Runs one user may have going on at the same time, by default (P-05). */
export const DEFAULT_RUNS_PER_USER = 3;

/**
 * Inserts the row of a new run, in the transaction of the caller, once the
 * owner of its session has fewer than `runsPerUser` active runs in other
 * sessions (P-05). A run of the same session is left to the unique index on
 * `active_session_id` (`RunAlreadyActive`). Throws `TooManyActiveRuns`.
 *
 * Two transactions that start runs of one user at the same time must count
 * one after the other. PostgreSQL takes a transaction advisory lock on the
 * owner first: it is the first lock of the transaction, and no other
 * transaction takes it, so it adds no cycle to the order of the row locks.
 * SQLite has one connection, so its transactions already go one at a time.
 */
export async function insertRun(
  trx: Knex.Transaction,
  row: RunRow,
  runsPerUser: number,
): Promise<void> {
  const session = await trx('sessions')
    .where({ id: row.session_id })
    .first<{ owner_ref: string } | undefined>('owner_ref');
  if (session) {
    if (isPostgres(trx)) {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [
        `ai-chat:runs:${session.owner_ref}`,
      ]);
    }
    const [{ count }] = await trx('runs')
      .join('sessions', 'sessions.id', 'runs.session_id')
      .where('sessions.owner_ref', session.owner_ref)
      .whereNot('runs.session_id', row.session_id)
      .whereNull('runs.parent_run_id')
      .whereIn('runs.status', ['running', 'waiting_approval'])
      .count<{ count: number | string }[]>({ count: '*' });
    if (Number(count) >= runsPerUser) {
      throw new TooManyActiveRuns(runsPerUser);
    }
  }
  await trx('runs').insert(row);
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

export type AttachmentRow = {
  id: string;
  session_id: string;
  owner_ref: string;
  media_type: AttachmentMeta['mediaType'];
  size: number;
  sha256: string;
  name: string;
  bytes: Uint8Array;
  created_at: string;
  used_seq: number | null;
  reserved_by: string | null;
};

/** The columns of an attachment without its bytes: a query for the meta never reads them. */
export const ATTACHMENT_META_COLUMNS = [
  'id',
  'session_id',
  'media_type',
  'size',
  'sha256',
  'name',
] as const;

export type AttachmentMetaRow = Pick<
  AttachmentRow,
  (typeof ATTACHMENT_META_COLUMNS)[number]
>;

export function toAttachmentMeta(row: AttachmentMetaRow): AttachmentMeta {
  return {
    id: row.id,
    sessionId: row.session_id,
    mediaType: row.media_type,
    name: row.name,
    size: Number(row.size),
    sha256: row.sha256,
  };
}

/**
 * Locks the attachments of `ids` (`FOR UPDATE`, in the order of their ids, so
 * two transactions that lock several never wait for each other) and checks
 * that each one is in the session. The session row is held already, so the
 * transactions of one session go one after the other; the order is for the
 * ones that do not hold it. Throws `UnknownAttachment` for the first id that
 * is missing or belongs to another session, unless `ignoreMissing` is set:
 * then it is left out. Returns the meta in the order of `ids`.
 */
export async function lockAttachments(
  trx: Knex.Transaction,
  sessionId: string,
  ids: string[],
  opts: { ignoreMissing?: boolean } = {},
): Promise<AttachmentMeta[]> {
  if (ids.length === 0) return [];
  const rows = await trx<AttachmentRow>('attachments')
    .whereIn('id', [...new Set(ids)])
    .orderBy('id', 'asc')
    .forUpdate()
    .select(...ATTACHMENT_META_COLUMNS);
  const byId = new Map(rows.map(row => [row.id, row]));
  const metas: AttachmentMeta[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.session_id !== sessionId) {
      if (opts.ignoreMissing) continue;
      throw new UnknownAttachment(id);
    }
    metas.push(toAttachmentMeta(row));
  }
  return metas;
}

/**
 * Marks the attachments as used by the message at `seq`: `used_seq` is set
 * when it is empty (the first message that uses an image keeps it), and the
 * hold of a queued message ends. Runs in the transaction that writes the
 * message, so a message never exists with attachments that are not marked.
 */
export async function markAttachmentsUsed(
  trx: Knex.Transaction,
  sessionId: string,
  ids: string[],
  seq: number,
): Promise<AttachmentMeta[]> {
  const metas = await lockAttachments(trx, sessionId, ids);
  if (ids.length > 0) {
    await trx('attachments')
      .whereIn('id', [...new Set(ids)])
      .update({
        used_seq: trx.raw('coalesce(used_seq, ?)', [seq]),
        reserved_by: null,
      });
  }
  return metas;
}

/**
 * Makes `reserved_by` of the attachments of a session say which queued
 * message holds each one: the first message (in the order of the queue) that
 * lists it. An attachment that no queued message lists is released. A queued
 * message may share an image with another, so a release by id would take the
 * hold of the other away. Call it in the transaction that changed the queue.
 */
export async function syncReservations(
  trx: Knex.Transaction,
  sessionId: string,
): Promise<void> {
  const queued = await trx('queued_messages')
    .where({ session_id: sessionId })
    .orderBy([
      { column: 'position', order: 'asc' },
      { column: 'id', order: 'asc' },
    ])
    .select<{ id: string; attachment_ids: string }[]>('id', 'attachment_ids');
  const holder = new Map<string, string>();
  for (const row of queued) {
    for (const id of JSON.parse(row.attachment_ids) as string[]) {
      if (!holder.has(id)) holder.set(id, row.id);
    }
  }
  const rows = await trx<AttachmentRow>('attachments')
    .where({ session_id: sessionId })
    .andWhere(q =>
      q.whereNotNull('reserved_by').orWhereIn('id', [...holder.keys()]),
    )
    .orderBy('id', 'asc')
    .forUpdate()
    .select('id', 'reserved_by');
  for (const row of rows) {
    const wanted = holder.get(row.id) ?? null;
    if (row.reserved_by !== wanted) {
      await trx('attachments')
        .where({ id: row.id })
        .update({ reserved_by: wanted });
    }
  }
}

/** The first message of the run does not count: the run may take `maxInsertsPerRun` more. */
export async function checkInsertLimit(
  trx: Knex.Transaction,
  sessionId: string,
  runId: string,
  maxInsertsPerRun: number,
): Promise<void> {
  const [{ n }] = await trx('items')
    .where({ session_id: sessionId, run_id: runId, kind: 'user_message' })
    .count({ n: '*' });
  // PostgreSQL gives a count as text, SQLite as a number.
  if (Number(n) - 1 >= maxInsertsPerRun) {
    throw new InsertLimitReached(runId, maxInsertsPerRun);
  }
}

/** The images of the user messages of the run, with `attachments`, are within the limit. */
export async function checkImageBytes(
  trx: Knex.Transaction,
  sessionId: string,
  runId: string,
  attachments: readonly AttachmentRef[] | undefined,
  maxImageBytesPerInput: number,
): Promise<void> {
  if (!attachments?.length) return;
  const rows = await trx('items')
    .where({ session_id: sessionId, run_id: runId, kind: 'user_message' })
    .select<{ payload: string }[]>('payload');
  const bytesOf = (refs?: readonly { size: number }[]) =>
    (refs ?? []).reduce((sum, ref) => sum + ref.size, 0);
  const total = rows.reduce(
    (sum, row) =>
      sum +
      bytesOf(
        (JSON.parse(row.payload) as { attachments?: { size: number }[] })
          .attachments,
      ),
    bytesOf(attachments),
  );
  if (total > maxImageBytesPerInput) {
    throw new TooManyImageBytes(runId, maxImageBytesPerInput);
  }
}

/** The meta of the attachments of `ids`, by id; one that is not in the session is not there. */
export async function readAttachmentMetas(
  db: Knex | Knex.Transaction,
  sessionId: string,
  ids: string[],
): Promise<Map<string, AttachmentMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await db<AttachmentRow>('attachments')
    .where({ session_id: sessionId })
    .whereIn('id', [...new Set(ids)])
    .select(...ATTACHMENT_META_COLUMNS);
  return new Map(rows.map(row => [row.id, toAttachmentMeta(row)]));
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

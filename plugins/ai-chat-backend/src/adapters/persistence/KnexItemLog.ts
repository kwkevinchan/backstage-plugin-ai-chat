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
  LeaseLost,
  dedupeKeyOf,
  isActiveStatus,
  type Clock,
  type Item,
  type ItemDraft,
  type ItemLog,
  type RunFence,
  type RunStatus,
} from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import { isUniqueViolation } from './uniqueViolation';

type ItemRow = {
  session_id: string;
  seq: number;
  run_id: string | null;
  kind: string;
  payload: string;
  dedupe_key: string | null;
  created_at: string;
};

/**
 * The kinds the host writes for the user, outside the loop. They need a run
 * that has not ended, but not the lease: an approval is written by whichever
 * backend gets the request, while the run waits and nobody holds the lease.
 */
const HOST_KINDS: ReadonlySet<string> = new Set(['user_message', 'approval']);

/**
 * The `ItemLog` of the `items` table.
 *
 * One transaction writes an append:
 *
 * 1. It reads the run with a shared lock and checks the fence: the run
 *    belongs to the session and, for what the loop writes, is running and
 *    held by the owner of the fence (else `LeaseLost`). Only a batch made
 *    of `user_message` and `approval` items skips the owner check and needs
 *    an active run instead.
 * 2. It adds the number of drafts to `sessions.next_seq` in one UPDATE. The
 *    UPDATE locks the row, so appends to one session go one after the other
 *    and take consecutive numbers; a rolled back append gives its numbers
 *    back.
 * 3. It refuses a draft whose key is in the log already (`DuplicateItem`).
 *    The unique index on `(session_id, dedupe_key)` is what guarantees it.
 * 4. It inserts the items.
 */
export class KnexItemLog implements ItemLog {
  constructor(private readonly knex: Knex, private readonly clock: Clock) {}

  async read(
    sessionId: string,
    opts: { afterSeq?: number } = {},
  ): Promise<Item[]> {
    const rows = await this.knex<ItemRow>('items')
      .where({ session_id: sessionId })
      .andWhere('seq', '>', opts.afterSeq ?? 0)
      .orderBy('seq', 'asc');
    return rows.map(toItem);
  }

  async append(
    sessionId: string,
    drafts: ItemDraft[],
    fence: RunFence,
  ): Promise<Item[]> {
    const keys = drafts.map(draft => dedupeKeyOf(draft));
    try {
      return await this.knex.transaction(async trx => {
        await this.checkFence(trx, sessionId, drafts, fence);
        if (drafts.length === 0) return [];

        const [{ next_seq: nextSeq }] = await trx('sessions')
          .where({ id: sessionId })
          .update({ next_seq: trx.raw('next_seq + ?', [drafts.length]) })
          .returning('next_seq');
        const firstSeq = nextSeq - drafts.length;

        await this.refuseDuplicates(trx, sessionId, keys);

        const createdAt = this.clock.now().toISOString();
        const rows: ItemRow[] = drafts.map((draft, index) => {
          const { kind, ...rest } = draft;
          return {
            session_id: sessionId,
            seq: firstSeq + index,
            run_id: fence.runId,
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
      });
    } catch (error) {
      if (isUniqueViolation(error, 'dedupe_key')) {
        throw new DuplicateItem(await this.firstExistingKey(sessionId, keys));
      }
      throw error;
    }
  }

  private async checkFence(
    trx: Knex.Transaction,
    sessionId: string,
    drafts: ItemDraft[],
    fence: RunFence,
  ): Promise<void> {
    const run = await trx('runs').where({ id: fence.runId }).forShare().first<{
      session_id: string;
      status: RunStatus;
      lease_owner: string | null;
    }>('session_id', 'status', 'lease_owner');
    if (!run || run.session_id !== sessionId) {
      throw new LeaseLost(fence.runId);
    }
    const hostOnly =
      drafts.length > 0 && drafts.every(draft => HOST_KINDS.has(draft.kind));
    const allowed = hostOnly
      ? isActiveStatus(run.status)
      : run.status === 'running' && run.lease_owner === fence.leaseOwner;
    if (!allowed) throw new LeaseLost(fence.runId);
  }

  private async refuseDuplicates(
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

  private async firstExistingKey(
    sessionId: string,
    keys: (string | undefined)[],
  ): Promise<string> {
    const wanted = keys.filter((key): key is string => key !== undefined);
    const existing = await this.knex('items')
      .where({ session_id: sessionId })
      .whereIn('dedupe_key', wanted)
      .first<{ dedupe_key: string }>('dedupe_key');
    return existing?.dedupe_key ?? wanted[0];
  }
}

function toItem(row: ItemRow): Item {
  return {
    ...JSON.parse(row.payload),
    kind: row.kind,
    sessionId: row.session_id,
    seq: row.seq,
    ...(row.run_id !== null && { runId: row.run_id }),
    createdAt: row.created_at,
  } as Item;
}

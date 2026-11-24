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
import { DEFAULT_INSERT_MAX_PER_RUN, InsertLimitReached } from '../../domain';
import { reserveSeq, toItem, writeItems, type ItemRow } from './transactions';
import { isUniqueViolation } from './uniqueViolation';

/**
 * The kinds the host writes for the user, outside the loop. They need a run
 * that has not ended, but not the lease: an approval is written by whichever
 * backend gets the request, while the run waits and nobody holds the lease.
 */
const HOST_KINDS: ReadonlySet<string> = new Set(['user_message', 'approval']);

/**
 * What an append writes, which decides the lock it takes on the run and the
 * check of the run:
 *
 * - `model`: the output of a model call (an `agent_message` or a `tool_call`
 *   in the batch). Written by the loop, so the lease must be held. It marks
 *   how far the model read.
 * - `insert`: one `user_message` the user inserted into a running run.
 * - `host`: the message that starts a run, or an approval.
 * - `loop`: anything else the loop writes (starts, results, summaries, plans).
 */
type WriteKind = 'model' | 'insert' | 'host' | 'loop';

function writeKindOf(drafts: ItemDraft[]): WriteKind {
  if (
    drafts.length === 1 &&
    drafts[0].kind === 'user_message' &&
    drafts[0].delivery === 'inserted'
  ) {
    return 'insert';
  }
  if (drafts.length > 0 && drafts.every(draft => HOST_KINDS.has(draft.kind))) {
    return 'host';
  }
  if (
    drafts.some(
      draft => draft.kind === 'agent_message' || draft.kind === 'tool_call',
    )
  ) {
    return 'model';
  }
  return 'loop';
}

/** The largest `readUpToSeq` of the model output of a batch, if it has one. */
function readUpToSeqOf(drafts: ItemDraft[]): number | undefined {
  let max: number | undefined;
  for (const draft of drafts) {
    if (draft.kind === 'agent_message' || draft.kind === 'tool_call') {
      if (draft.readUpToSeq !== undefined) {
        max = Math.max(max ?? 0, draft.readUpToSeq);
      }
    }
  }
  return max;
}

/**
 * The `ItemLog` of the `items` table.
 *
 * One transaction writes an append, and it touches the tables in the order
 * `runs`, `sessions`, `items`:
 *
 * 1. It reads the run and checks the fence: the run belongs to the session
 *    and, for what the loop writes, is running and held by the owner of the
 *    fence (else `LeaseLost`). A batch made of `user_message` and `approval`
 *    items skips the owner check and needs an active run instead. An inserted
 *    message (IN-11) needs a run that is `running` with a lease that has not
 *    expired, and no owner. The lock is `FOR SHARE`, except for the output of
 *    a model call: that takes `FOR NO KEY UPDATE` at once, because a shared
 *    lock that is raised later waits for the shared locks of the inserts and
 *    queue writes, which wait for it (a deadlock in PostgreSQL).
 * 2. The output of a model call sets `runs.read_up_to_seq` to the number its
 *    items say they read up to. The run cannot end before an inserted message
 *    with a larger `seq` is read (`KnexRunRepository.transition`).
 * 3. It adds the number of drafts to `sessions.next_seq` in one UPDATE. The
 *    UPDATE locks the row, so appends to one session go one after the other
 *    and take consecutive numbers; a rolled back append gives its numbers
 *    back.
 * 4. An inserted message must not be one more than `maxInsertsPerRun`
 *    (`InsertLimitReached`). The check comes after step 3, so two inserts at
 *    the same time do not both pass it.
 * 5. It refuses a draft whose key is in the log already (`DuplicateItem`).
 *    The unique index on `(session_id, dedupe_key)` is what guarantees it.
 * 6. It inserts the items.
 */
export class KnexItemLog implements ItemLog {
  private readonly maxInsertsPerRun: number;

  /** @param options.maxInsertsPerRun - `aiChat.input.insert.maxPerRun`. 5 by default. */
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    options: { maxInsertsPerRun?: number } = {},
  ) {
    this.maxInsertsPerRun =
      options.maxInsertsPerRun ?? DEFAULT_INSERT_MAX_PER_RUN;
  }

  async read(
    sessionId: string,
    opts: { afterSeq?: number; fromLatestSummary?: boolean } = {},
  ): Promise<Item[]> {
    let afterSeq = opts.afterSeq ?? 0;
    if (opts.fromLatestSummary) {
      // Two plain queries: the newest summary, then the items after it. An
      // item written in between only adds a later item, so the bound is still
      // right. The newest summary has the highest `seq` of its kind; the key
      // `(session_id, seq)` walks back from the end to find it.
      const summary = await this.knex<ItemRow>('items')
        .where({ session_id: sessionId, kind: 'summary' })
        .orderBy('seq', 'desc')
        .first('payload');
      if (summary) {
        const { coversUpToSeq } = JSON.parse(summary.payload) as {
          coversUpToSeq?: unknown;
        };
        // A summary that does not say how far it goes counts as no summary.
        if (
          typeof coversUpToSeq === 'number' &&
          Number.isFinite(coversUpToSeq)
        ) {
          afterSeq = Math.max(afterSeq, coversUpToSeq);
        }
      }
    }
    const rows = await this.knex<ItemRow>('items')
      .where({ session_id: sessionId })
      .andWhere('seq', '>', afterSeq)
      .orderBy('seq', 'asc');
    return rows.map(toItem);
  }

  async append(
    sessionId: string,
    drafts: ItemDraft[],
    fence: RunFence,
  ): Promise<Item[]> {
    const keys = drafts.map(draft => dedupeKeyOf(draft));
    const kind = writeKindOf(drafts);
    try {
      return await this.knex.transaction(async trx => {
        await this.checkFence(trx, sessionId, kind, fence);
        if (drafts.length === 0) return [];

        if (kind === 'model') {
          await this.markRead(trx, fence.runId, readUpToSeqOf(drafts));
        }
        const firstSeq = await reserveSeq(trx, sessionId, drafts.length);
        if (kind === 'insert') {
          await this.checkInsertLimit(trx, sessionId, fence.runId);
        }
        return writeItems(trx, this.clock, {
          sessionId,
          runId: fence.runId,
          firstSeq,
          drafts,
          keys,
        });
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
    kind: WriteKind,
    fence: RunFence,
  ): Promise<void> {
    const query = trx('runs').where({ id: fence.runId });
    const run = await (kind === 'model'
      ? query.forNoKeyUpdate()
      : query.forShare()
    ).first<{
      session_id: string;
      status: RunStatus;
      lease_owner: string | null;
      lease_expires_at: string | null;
    }>('session_id', 'status', 'lease_owner', 'lease_expires_at');
    if (!run || run.session_id !== sessionId) {
      throw new LeaseLost(fence.runId);
    }
    let allowed: boolean;
    switch (kind) {
      case 'insert':
        allowed =
          run.status === 'running' &&
          run.lease_expires_at !== null &&
          run.lease_expires_at >= this.clock.now().toISOString();
        break;
      case 'host':
        allowed = isActiveStatus(run.status);
        break;
      default:
        allowed =
          run.status === 'running' && run.lease_owner === fence.leaseOwner;
    }
    if (!allowed) throw new LeaseLost(fence.runId);
  }

  /**
   * Raises `runs.read_up_to_seq` to what the model output read up to. It is
   * the first write of the transaction and the run row is locked already, so
   * no other transaction holds `sessions` while it waits for this one.
   */
  private async markRead(
    trx: Knex.Transaction,
    runId: string,
    readUpToSeq: number | undefined,
  ): Promise<void> {
    if (readUpToSeq === undefined) return;
    await trx('runs')
      .where({ id: runId })
      .andWhere('read_up_to_seq', '<', readUpToSeq)
      .update({ read_up_to_seq: readUpToSeq });
  }

  /** The first message of the run does not count: the run may take `maxInsertsPerRun` more. */
  private async checkInsertLimit(
    trx: Knex.Transaction,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const [{ n }] = await trx('items')
      .where({ session_id: sessionId, run_id: runId, kind: 'user_message' })
      .count({ n: '*' });
    // PostgreSQL gives a count as text, SQLite as a number.
    if (Number(n) - 1 >= this.maxInsertsPerRun) {
      throw new InsertLimitReached(runId, this.maxInsertsPerRun);
    }
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

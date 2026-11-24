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

import type {
  Clock,
  IdGenerator,
  ItemDraft,
  PageContext,
} from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import type { QueuedMessageRepository } from '../../application/ports';
import {
  NoActiveRun,
  QueueChanged,
  QueuedMessageNotFound,
  QueueFull,
  SessionNotFound,
  type LeasedRun,
  type QueuedMessage,
} from '../../domain';
import {
  leased,
  newRunRow,
  reserveSeq,
  toRun,
  writeItems,
} from './transactions';
import { isUniqueViolation } from './uniqueViolation';

type QueuedRow = {
  id: string;
  session_id: string;
  position: number;
  text: string;
  attachment_ids: string;
  page: string | null;
  created_at: string;
  updated_at: string;
};

/** Thrown inside `startNext` to roll the transaction back with nothing to report. */
class NothingToStart extends Error {}

/**
 * The queued messages in the `queued_messages` table.
 *
 * Every change of a queue is one transaction that locks the row of the session
 * first (`FOR NO KEY UPDATE`, the level an append takes on it), so the
 * changes of one session go one after the other. A transaction that also needs
 * a run takes the run first: the order is `runs`, `sessions`, `items`,
 * `queued_messages`, the same as in `KnexItemLog`.
 *
 * `position` has no unique index: a reorder writes the new values one row at
 * a time, and two rows hold the same value for a moment.
 */
export class KnexQueuedMessageRepository implements QueuedMessageRepository {
  private readonly leaseSeconds: number;

  /** @param options.leaseSeconds - The lease of the run `startNext` makes; 30 by default, as in `KnexRunRepository`. */
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: { leaseSeconds?: number } = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
  }

  async list(sessionId: string): Promise<QueuedMessage[]> {
    const rows = await this.knex<QueuedRow>('queued_messages')
      .where({ session_id: sessionId })
      .orderBy([
        { column: 'position', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    return rows.map(toQueued);
  }

  async add(
    sessionId: string,
    input: { text: string; page?: PageContext },
    opts: { max: number },
  ): Promise<QueuedMessage> {
    return this.knex.transaction(async trx => {
      // A shared lock on the run: it cannot end while this transaction is
      // open, so a message that is queued is there when the run ends. A run
      // that ended first no longer has `active_session_id`, so it is not found.
      const run = await trx('runs')
        .where({ active_session_id: sessionId })
        .forShare()
        .first('id');
      if (!run) throw new NoActiveRun(sessionId);
      await this.lockSession(trx, sessionId);
      const [{ n, last }] = await trx('queued_messages')
        .where({ session_id: sessionId })
        .count({ n: '*' })
        .max({ last: 'position' });
      if (Number(n) >= opts.max) throw new QueueFull(sessionId, opts.max);
      const now = this.clock.now().toISOString();
      const row: QueuedRow = {
        id: this.ids.next(),
        session_id: sessionId,
        position: Number(last ?? 0) + 1,
        text: input.text,
        attachment_ids: '[]',
        page: input.page ? JSON.stringify(input.page) : null,
        created_at: now,
        updated_at: now,
      };
      await trx('queued_messages').insert(row);
      return toQueued(row);
    });
  }

  async update(
    sessionId: string,
    id: string,
    patch: { text?: string; page?: PageContext | null },
  ): Promise<QueuedMessage> {
    return this.knex.transaction(async trx => {
      await this.lockSession(trx, sessionId);
      const changes: Partial<QueuedRow> = {
        updated_at: this.clock.now().toISOString(),
      };
      if (patch.text !== undefined) changes.text = patch.text;
      if (patch.page !== undefined) {
        changes.page = patch.page === null ? null : JSON.stringify(patch.page);
      }
      const count = await trx('queued_messages')
        .where({ id, session_id: sessionId })
        .update(changes);
      if (count === 0) throw new QueuedMessageNotFound(id);
      const row = await trx<QueuedRow>('queued_messages').where({ id }).first();
      return toQueued(row!);
    });
  }

  async remove(sessionId: string, id: string): Promise<void> {
    await this.knex.transaction(async trx => {
      await this.lockSession(trx, sessionId);
      const count = await trx('queued_messages')
        .where({ id, session_id: sessionId })
        .delete();
      if (count === 0) throw new QueuedMessageNotFound(id);
    });
  }

  async reorder(sessionId: string, ids: string[]): Promise<QueuedMessage[]> {
    return this.knex.transaction(async trx => {
      await this.lockSession(trx, sessionId);
      const rows = await trx<QueuedRow>('queued_messages')
        .where({ session_id: sessionId })
        .select('id');
      const known = new Set(rows.map(row => row.id));
      if (
        ids.length !== known.size ||
        new Set(ids).size !== ids.length ||
        !ids.every(id => known.has(id))
      ) {
        throw new QueueChanged(sessionId);
      }
      for (const [index, id] of ids.entries()) {
        await trx('queued_messages')
          .where({ id })
          .update({ position: index + 1 });
      }
      const ordered = await trx<QueuedRow>('queued_messages')
        .where({ session_id: sessionId })
        .orderBy('position', 'asc');
      return ordered.map(toQueued);
    });
  }

  async startNext(
    sessionId: string,
  ): Promise<{ run: LeasedRun; message: QueuedMessage } | undefined> {
    try {
      return await this.knex.transaction(async trx => {
        // The run first. Its unique index on `active_session_id` is what stops
        // a second start: of two transactions that insert at the same time,
        // the second waits for the first and then fails.
        const row = newRunRow(
          {
            clock: this.clock,
            ids: this.ids,
            leaseSeconds: this.leaseSeconds,
          },
          sessionId,
        );
        await trx('runs').insert(row);
        await this.lockSession(trx, sessionId);
        const first = await trx<QueuedRow>('queued_messages')
          .where({ session_id: sessionId })
          .orderBy([
            { column: 'position', order: 'asc' },
            { column: 'id', order: 'asc' },
          ])
          .first();
        if (!first) throw new NothingToStart();
        const deleted = await trx('queued_messages')
          .where({ id: first.id })
          .delete();
        if (deleted !== 1) throw new NothingToStart();

        const message = toQueued(first);
        const draft: ItemDraft = {
          kind: 'user_message',
          text: message.text,
          ...(message.page && { page: message.page }),
          delivery: 'queued',
        };
        const firstSeq = await reserveSeq(trx, sessionId, 1);
        await writeItems(trx, this.clock, {
          sessionId,
          runId: row.id,
          firstSeq,
          drafts: [draft],
          keys: [undefined],
        });
        return { run: leased(toRun(row)), message };
      });
    } catch (error) {
      if (
        error instanceof NothingToStart ||
        isUniqueViolation(error, 'active_session_id')
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private async lockSession(
    trx: Knex.Transaction,
    sessionId: string,
  ): Promise<void> {
    const session = await trx('sessions')
      .where({ id: sessionId })
      .forNoKeyUpdate()
      .first('id');
    if (!session) throw new SessionNotFound(sessionId);
  }
}

function toQueued(row: QueuedRow): QueuedMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    position: row.position,
    text: row.text,
    ...(row.page !== null && { page: JSON.parse(row.page) as PageContext }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
  Item,
  ItemDraft,
  MessageReference,
  PageContext,
  RunStatus,
} from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import type { QueuedMessageRepository } from '../../application/ports';
import {
  type AttachmentMeta,
  DEFAULT_IMAGE_LIMITS,
  DEFAULT_INSERT_MAX_PER_RUN,
  NoActiveRun,
  QueueChanged,
  QueuedMessageNotFound,
  QueueFull,
  RunNotRunning,
  SessionNotFound,
  type LeasedRun,
  type QueuedMessage,
} from '../../domain';
import {
  checkImageBytes,
  checkInsertLimit,
  DEFAULT_RUNS_PER_USER,
  insertRun,
  leased,
  lockAttachments,
  markAttachmentsUsed,
  newRunRow,
  readAttachmentMetas,
  reserveSeq,
  syncReservations,
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
  message_references: string | null;
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
 * The attachments of a queued message are held with `reserved_by` while it
 * waits (`syncReservations` after each change), and marked used in the
 * transaction that writes it as a message (`startNext`).
 *
 * `position` has no unique index: a reorder writes the new values one row at
 * a time, and two rows hold the same value for a moment.
 */
export class KnexQueuedMessageRepository implements QueuedMessageRepository {
  private readonly leaseSeconds: number;
  private readonly runsPerUser: number;

  /**
   * @param options.leaseSeconds - The lease of the run `startNext` makes; 30
   * by default, as in `KnexRunRepository`.
   * @param options.runsPerUser - Runs one user may have going on (P-05); 3 by
   * default, as in `KnexRunRepository`.
   */
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: { leaseSeconds?: number; runsPerUser?: number } = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.runsPerUser = options.runsPerUser ?? DEFAULT_RUNS_PER_USER;
  }

  async list(sessionId: string): Promise<QueuedMessage[]> {
    const rows = await this.knex<QueuedRow>('queued_messages')
      .where({ session_id: sessionId })
      .orderBy([
        { column: 'position', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    const metas = await readAttachmentMetas(
      this.knex,
      sessionId,
      rows.flatMap(row => idsOf(row)),
    );
    return rows.map(row => toQueued(row, metas));
  }

  async add(
    sessionId: string,
    input: {
      text: string;
      attachmentIds?: string[];
      page?: PageContext;
      references?: MessageReference[];
    },
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
      const attachmentIds = input.attachmentIds ?? [];
      const row: QueuedRow = {
        id: this.ids.next(),
        session_id: sessionId,
        position: Number(last ?? 0) + 1,
        text: input.text,
        attachment_ids: JSON.stringify(attachmentIds),
        page: input.page ? JSON.stringify(input.page) : null,
        message_references: input.references?.length
          ? JSON.stringify(input.references)
          : null,
        created_at: now,
        updated_at: now,
      };
      await trx('queued_messages').insert(row);
      const metas = await lockAttachments(trx, sessionId, attachmentIds);
      await syncReservations(trx, sessionId);
      return toQueued(row, byId(metas));
    });
  }

  async update(
    sessionId: string,
    id: string,
    patch: {
      text?: string;
      attachmentIds?: string[];
      page?: PageContext | null;
      references?: MessageReference[];
    },
  ): Promise<QueuedMessage> {
    return this.knex.transaction(async trx => {
      await this.lockSession(trx, sessionId);
      const changes: Partial<QueuedRow> = {
        updated_at: this.clock.now().toISOString(),
      };
      if (patch.text !== undefined) changes.text = patch.text;
      if (patch.attachmentIds !== undefined) {
        changes.attachment_ids = JSON.stringify(patch.attachmentIds);
      }
      if (patch.page !== undefined) {
        changes.page = patch.page === null ? null : JSON.stringify(patch.page);
      }
      if (patch.references !== undefined) {
        changes.message_references =
          patch.references.length > 0 ? JSON.stringify(patch.references) : null;
      }
      const count = await trx('queued_messages')
        .where({ id, session_id: sessionId })
        .update(changes);
      if (count === 0) throw new QueuedMessageNotFound(id);
      const row = (await trx<QueuedRow>('queued_messages')
        .where({ id })
        .first())!;
      // Locks the images of the message, and fails when one is not in the
      // session; the update is rolled back with it.
      const metas = await lockAttachments(trx, sessionId, idsOf(row));
      await syncReservations(trx, sessionId);
      return toQueued(row, byId(metas));
    });
  }

  async remove(sessionId: string, id: string): Promise<void> {
    await this.knex.transaction(async trx => {
      await this.lockSession(trx, sessionId);
      const count = await trx('queued_messages')
        .where({ id, session_id: sessionId })
        .delete();
      if (count === 0) throw new QueuedMessageNotFound(id);
      await syncReservations(trx, sessionId);
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
      // The first message that lists an image holds it: the order decides.
      await syncReservations(trx, sessionId);
      const ordered = await trx<QueuedRow>('queued_messages')
        .where({ session_id: sessionId })
        .orderBy('position', 'asc');
      const metas = await readAttachmentMetas(
        trx,
        sessionId,
        ordered.flatMap(row => idsOf(row)),
      );
      return ordered.map(row => toQueued(row, metas));
    });
  }

  async startNext(
    sessionId: string,
  ): Promise<{ run: LeasedRun; message: QueuedMessage } | undefined> {
    try {
      return await this.knex.transaction(async trx => {
        // The run first, within the runs of the user (`insertRun`). Its unique
        // index on `active_session_id` is what stops a second start: of two
        // transactions that insert at the same time, the second waits for the
        // first and then fails.
        const row = newRunRow(
          {
            clock: this.clock,
            ids: this.ids,
            leaseSeconds: this.leaseSeconds,
          },
          sessionId,
        );
        // An empty queue has nothing to start, whatever the runs of the user:
        // it answers `undefined` before the limit is counted. It takes no lock;
        // the read under the lock of the session below decides.
        const any = await trx('queued_messages')
          .where({ session_id: sessionId })
          .first('id');
        if (!any) throw new NothingToStart();
        await insertRun(trx, row, this.runsPerUser);
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

        // An image that is gone is left out of the message; one that is held
        // cannot be deleted, so this is for a row that was changed by hand.
        const metas = await lockAttachments(trx, sessionId, idsOf(first), {
          ignoreMissing: true,
        });
        const message = toQueued(first, byId(metas));
        const draft: ItemDraft = {
          kind: 'user_message',
          text: message.text,
          ...(metas.length > 0 && {
            attachments: metas.map(meta => ({
              id: meta.id,
              mediaType: meta.mediaType,
              name: meta.name,
              size: meta.size,
            })),
          }),
          ...(message.page && { page: message.page }),
          ...(message.references && { references: message.references }),
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
        await markAttachmentsUsed(
          trx,
          sessionId,
          metas.map(meta => meta.id),
          firstSeq,
        );
        await syncReservations(trx, sessionId);
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

  async insert(
    sessionId: string,
    id: string,
    runId: string,
    opts: { maxInsertsPerRun?: number; maxImageBytesPerInput?: number } = {},
  ): Promise<Item> {
    const maxInsertsPerRun =
      opts.maxInsertsPerRun ?? DEFAULT_INSERT_MAX_PER_RUN;
    const maxImageBytesPerInput =
      opts.maxImageBytesPerInput ?? DEFAULT_IMAGE_LIMITS.maxBytesPerInput;
    return this.knex.transaction(async trx => {
      // Lock order: runs (FOR SHARE), sessions (FOR NO KEY UPDATE),
      // queued_messages, attachments (FOR UPDATE), items, attachments.
      const run = await trx('runs').where({ id: runId }).forShare().first<{
        session_id: string;
        status: RunStatus;
        lease_expires_at: string | null;
      }>('session_id', 'status', 'lease_expires_at');
      if (
        !run ||
        run.session_id !== sessionId ||
        run.status !== 'running' ||
        run.lease_expires_at === null ||
        run.lease_expires_at < this.clock.now().toISOString()
      ) {
        throw new RunNotRunning(runId);
      }
      await this.lockSession(trx, sessionId);
      const row = await trx<QueuedRow>('queued_messages')
        .where({ id, session_id: sessionId })
        .first();
      if (!row) throw new QueuedMessageNotFound(id);
      const deleted = await trx('queued_messages')
        .where({ id, session_id: sessionId })
        .delete();
      if (deleted !== 1) throw new QueuedMessageNotFound(id);

      const metas = await lockAttachments(trx, sessionId, idsOf(row), {
        ignoreMissing: true,
      });
      const attachments = metas.map(meta => ({
        id: meta.id,
        mediaType: meta.mediaType,
        name: meta.name,
        size: meta.size,
      }));
      await checkInsertLimit(trx, sessionId, runId, maxInsertsPerRun);
      await checkImageBytes(
        trx,
        sessionId,
        runId,
        attachments,
        maxImageBytesPerInput,
      );
      const draft: ItemDraft = {
        kind: 'user_message',
        text: row.text,
        ...(attachments.length > 0 && { attachments }),
        ...(row.page !== null && {
          page: JSON.parse(row.page) as PageContext,
        }),
        ...(row.message_references !== null && {
          references: referencesOf(row.message_references),
        }),
        delivery: 'inserted',
      };
      const firstSeq = await reserveSeq(trx, sessionId, 1);
      const [written] = await writeItems(trx, this.clock, {
        sessionId,
        runId,
        firstSeq,
        drafts: [draft],
        keys: [undefined],
      });
      await markAttachmentsUsed(
        trx,
        sessionId,
        metas.map(meta => meta.id),
        firstSeq,
      );
      await syncReservations(trx, sessionId);
      return written;
    });
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

function referencesOf(json: string): MessageReference[] {
  return JSON.parse(json) as MessageReference[];
}

function idsOf(row: QueuedRow): string[] {
  return JSON.parse(row.attachment_ids) as string[];
}

function byId(metas: AttachmentMeta[]): Map<string, AttachmentMeta> {
  return new Map(metas.map(meta => [meta.id, meta]));
}

function toQueued(
  row: QueuedRow,
  metas: Map<string, AttachmentMeta>,
): QueuedMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    position: row.position,
    text: row.text,
    attachments: idsOf(row).flatMap(id => {
      const meta = metas.get(id);
      return meta ? [meta] : [];
    }),
    ...(row.page !== null && { page: JSON.parse(row.page) as PageContext }),
    ...(row.message_references !== null && {
      references: referencesOf(row.message_references),
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

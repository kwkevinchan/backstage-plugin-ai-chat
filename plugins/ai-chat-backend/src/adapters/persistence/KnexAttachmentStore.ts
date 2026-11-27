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

import { createHash } from 'node:crypto';
import type { Clock, IdGenerator } from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import { isPostgres } from './postgres';
import type { AttachmentStore } from '../../application/ports';
import {
  AttachmentInUse,
  AttachmentNotFound,
  SessionNotFound,
  TooManyPendingAttachments,
  type AttachmentMeta,
} from '../../domain';
import {
  ATTACHMENT_META_COLUMNS,
  toAttachmentMeta,
  type AttachmentRow,
} from './transactions';

/**
 * The `AttachmentStore` on the `attachments` table.
 *
 * - `put` locks the row of the session first (`FOR NO KEY UPDATE`, the level
 *   an append takes), so two uploads at the same time do not both pass the
 *   check of the number of images that are in no message.
 * - The queries that need only the meta name the columns: they never read the
 *   bytes.
 * - `purgeUnused` selects the rows to delete with `FOR UPDATE SKIP LOCKED`.
 *   A transaction that marks an image as used holds its row, so the cleaning
 *   skips it instead of waiting for it (and cannot delete it).
 */
export class KnexAttachmentStore implements AttachmentStore {
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async put(
    input: Parameters<AttachmentStore['put']>[0],
  ): Promise<AttachmentMeta> {
    return this.knex.transaction(async trx => {
      const session = await trx('sessions')
        .where({ id: input.sessionId })
        .forNoKeyUpdate()
        .first('id');
      if (!session) throw new SessionNotFound(input.sessionId);
      const [{ n }] = await trx('attachments')
        .where({ session_id: input.sessionId })
        .whereNull('used_seq')
        .count({ n: '*' });
      if (Number(n) >= input.maxPending) {
        throw new TooManyPendingAttachments(input.sessionId, input.maxPending);
      }
      const row: AttachmentRow = {
        id: this.ids.next(),
        session_id: input.sessionId,
        owner_ref: input.ownerRef,
        media_type: input.mediaType,
        size: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        name: input.name,
        bytes: Buffer.from(input.bytes),
        created_at: this.clock.now().toISOString(),
        used_seq: null,
        reserved_by: null,
      };
      await trx('attachments').insert(row);
      return toAttachmentMeta(row);
    });
  }

  async get(
    sessionId: string,
    id: string,
  ): Promise<{ meta: AttachmentMeta; bytes: Uint8Array }> {
    const row = await this.knex<AttachmentRow>('attachments')
      .where({ id, session_id: sessionId })
      .first(...ATTACHMENT_META_COLUMNS, 'bytes');
    if (!row) throw new AttachmentNotFound(id);
    return { meta: toAttachmentMeta(row), bytes: new Uint8Array(row.bytes) };
  }

  async describe(sessionId: string, ids: string[]): Promise<AttachmentMeta[]> {
    if (ids.length === 0) return [];
    const rows = await this.knex<AttachmentRow>('attachments')
      .where({ session_id: sessionId })
      .whereIn('id', [...new Set(ids)])
      .select(...ATTACHMENT_META_COLUMNS);
    const byId = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => {
      const row = byId.get(id);
      if (!row) throw new AttachmentNotFound(id);
      return toAttachmentMeta(row);
    });
  }

  async copy(
    input: Parameters<AttachmentStore['copy']>[0],
  ): Promise<Map<string, AttachmentMeta>> {
    const copies = new Map<string, AttachmentMeta>();
    if (input.ids.length === 0) return copies;
    await this.knex.transaction(async trx => {
      const rows = await trx<AttachmentRow>('attachments')
        .where({ session_id: input.fromSessionId })
        .whereIn('id', [...new Set(input.ids)])
        .select(...ATTACHMENT_META_COLUMNS, 'bytes');
      const createdAt = this.clock.now().toISOString();
      for (const row of rows) {
        const copy: AttachmentRow = {
          ...row,
          id: this.ids.next(),
          session_id: input.toSessionId,
          owner_ref: input.ownerRef,
          created_at: createdAt,
          used_seq: null,
          reserved_by: null,
        };
        await trx('attachments').insert(copy);
        copies.set(row.id, toAttachmentMeta(copy));
      }
    });
    return copies;
  }

  async deletePending(
    input: Parameters<AttachmentStore['deletePending']>[0],
  ): Promise<void> {
    await this.knex.transaction(async trx => {
      const query = trx<AttachmentRow>('attachments').where({
        id: input.id,
        session_id: input.sessionId,
        owner_ref: input.ownerRef,
      });
      const row = await (isPostgres(trx) ? query.forUpdate() : query).first(
        'id',
        'used_seq',
        'reserved_by',
      );
      if (!row) throw new AttachmentNotFound(input.id);
      if (row.used_seq !== null || row.reserved_by !== null) {
        throw new AttachmentInUse(input.id);
      }
      await trx('attachments')
        .where({ id: row.id })
        .whereNull('used_seq')
        .whereNull('reserved_by')
        .delete();
    });
  }

  async purgeUnused(olderThan: Date): Promise<number> {
    return this.knex.transaction(async trx => {
      const candidates = trx<AttachmentRow>('attachments')
        .whereNull('used_seq')
        .whereNull('reserved_by')
        .andWhere('created_at', '<', olderThan.toISOString())
        .orderBy('id', 'asc');
      // SQLite has no row locks: its transactions go one after the other.
      const rows = await (isPostgres(trx)
        ? candidates.forUpdate().skipLocked()
        : candidates
      ).select('id');
      if (rows.length === 0) return 0;
      // The conditions again: a row that was updated while it was selected is
      // read in its newest version, but the delete does not rely on that.
      const deleted = await trx('attachments')
        .whereIn(
          'id',
          rows.map(row => row.id),
        )
        .whereNull('used_seq')
        .whereNull('reserved_by')
        .delete();
      return deleted;
    });
  }
}

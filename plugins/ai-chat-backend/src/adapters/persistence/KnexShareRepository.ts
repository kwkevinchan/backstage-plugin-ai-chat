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

import type { Clock, IdGenerator } from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import type { ShareRepository } from '../../application/ports';
import type { NewShare, Share } from '../../domain';

type ShareRow = {
  id: string;
  session_id: string;
  subject_ref: string;
  up_to_seq: number | null;
  outputs_up_to_seq: number | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
};

/** The shares in the `shares` table. */
export class KnexShareRepository implements ShareRepository {
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async add(input: NewShare): Promise<Share> {
    const row: ShareRow = {
      id: this.ids.next(),
      session_id: input.sessionId,
      subject_ref: input.subjectRef,
      up_to_seq: input.upToSeq ?? null,
      outputs_up_to_seq: input.outputsUpToSeq ?? null,
      expires_at: input.expiresAt ?? null,
      created_by: input.createdBy,
      created_at: this.clock.now().toISOString(),
      revoked_at: null,
    };
    await this.knex('shares').insert(row);
    return toShare(row);
  }

  async listBySession(sessionId: string): Promise<Share[]> {
    const rows = await this.knex<ShareRow>('shares')
      .where({ session_id: sessionId })
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    return rows.map(toShare);
  }

  async listActiveFor(
    sessionId: string,
    subjectRefs: readonly string[],
  ): Promise<Share[]> {
    if (subjectRefs.length === 0) return [];
    const rows = await this.knex<ShareRow>('shares')
      .where({ session_id: sessionId })
      .whereNull('revoked_at')
      .whereIn('subject_ref', subjectRefs as string[])
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    return rows.map(toShare);
  }
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    sessionId: row.session_id,
    subjectRef: row.subject_ref,
    ...(row.up_to_seq !== null ? { upToSeq: row.up_to_seq } : {}),
    ...(row.outputs_up_to_seq !== null
      ? { outputsUpToSeq: row.outputs_up_to_seq }
      : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

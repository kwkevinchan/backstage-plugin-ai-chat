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

import { InputError } from '@backstage/errors';
import type { Clock, IdGenerator } from '@kwkevinchan/ai-chat-harness';
import type { Knex } from 'knex';
import type { ShareRepository } from '../../application/ports';
import type { NewShare, Share, ShareScope } from '../../domain';

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
      id: input.id ?? this.ids.next(),
      session_id: input.sessionId,
      subject_ref: input.subjectRef,
      up_to_seq: input.upToSeq ?? null,
      outputs_up_to_seq: input.outputsUpToSeq ?? null,
      expires_at: toIso8601(input.expiresAt),
      created_by: input.createdBy,
      created_at: this.clock.now().toISOString(),
      revoked_at: null,
    };
    await this.knex('shares').insert(row);
    return toShare(row);
  }

  async get(sessionId: string, shareId: string): Promise<Share | undefined> {
    const row = await this.knex<ShareRow>('shares')
      .where({ session_id: sessionId, id: shareId })
      .first();
    return row ? toShare(row) : undefined;
  }

  async update(
    sessionId: string,
    shareId: string,
    change: ShareScope & { expiresAt?: string },
  ): Promise<Share | undefined> {
    const values: Partial<ShareRow> = {
      up_to_seq: change.upToSeq ?? null,
      outputs_up_to_seq: change.outputsUpToSeq ?? null,
      ...(change.expiresAt !== undefined && {
        expires_at: toIso8601(change.expiresAt),
      }),
    };
    const changed = await this.knex<ShareRow>('shares')
      .where({ session_id: sessionId, id: shareId })
      .whereNull('revoked_at')
      .update(values);
    if (changed === 0) return undefined;
    return this.get(sessionId, shareId);
  }

  async revoke(sessionId: string, shareId: string): Promise<Share | undefined> {
    const changed = await this.knex<ShareRow>('shares')
      .where({ session_id: sessionId, id: shareId })
      .whereNull('revoked_at')
      .update({ revoked_at: this.clock.now().toISOString() });
    if (changed === 0) return undefined;
    return this.get(sessionId, shareId);
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

function toIso8601(value: string | undefined): string | null {
  if (value === undefined) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new InputError(`expiresAt is not an ISO 8601 instant: ${value}`);
  }
  return instant.toISOString();
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

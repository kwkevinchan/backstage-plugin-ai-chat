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
import type { SessionRepository } from '../../application/ports';
import {
  SessionNotFound,
  type NewSession,
  type Session,
  type SessionPatch,
} from '../../domain';

type SessionRow = {
  id: string;
  owner_ref: string;
  agent_id: string;
  title: string | null;
  entity_ref: string | null;
  enabled_toolsets: string;
  forked_from_session: string | null;
  forked_from_seq: number | null;
  pinned: boolean | number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The sessions in the `sessions` table. */
export class KnexSessionRepository implements SessionRepository {
  constructor(
    private readonly knex: Knex,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: NewSession): Promise<Session> {
    const now = this.clock.now().toISOString();
    const row = {
      id: this.ids.next(),
      owner_ref: input.ownerRef,
      agent_id: input.agentId,
      title: input.title ?? null,
      entity_ref: input.entityRef ?? null,
      enabled_toolsets: JSON.stringify(input.enabledToolsets ?? []),
      forked_from_session: input.forkedFrom?.sessionId ?? null,
      forked_from_seq: input.forkedFrom?.seq ?? null,
      pinned: false,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.knex('sessions').insert(row);
    return toSession(row);
  }

  async get(sessionId: string): Promise<Session> {
    const row = await this.knex<SessionRow>('sessions')
      .where({ id: sessionId })
      .first();
    if (!row) throw new SessionNotFound(sessionId);
    return toSession(row);
  }

  async listByOwner(
    ownerRef: string,
    opts: { includeArchived?: boolean; limit?: number } = {},
  ): Promise<Session[]> {
    const query = this.knex<SessionRow>('sessions')
      .where({ owner_ref: ownerRef })
      .orderBy([
        { column: 'updated_at', order: 'desc' },
        { column: 'id', order: 'asc' },
      ]);
    if (!opts.includeArchived) query.whereNull('archived_at');
    if (opts.limit !== undefined) query.limit(opts.limit);
    return (await query).map(toSession);
  }

  async update(sessionId: string, patch: SessionPatch): Promise<Session> {
    const now = this.clock.now().toISOString();
    const changes: Record<string, unknown> = { updated_at: now };
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.pinned !== undefined) changes.pinned = patch.pinned;
    if (patch.archived !== undefined) {
      changes.archived_at = patch.archived ? now : null;
    }
    if (patch.enabledToolsets !== undefined) {
      changes.enabled_toolsets = JSON.stringify(patch.enabledToolsets);
    }
    const count = await this.knex('sessions')
      .where({ id: sessionId })
      .update(changes);
    if (count === 0) throw new SessionNotFound(sessionId);
    return this.get(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    const count = await this.knex('sessions').where({ id: sessionId }).delete();
    if (count === 0) throw new SessionNotFound(sessionId);
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    agentId: row.agent_id,
    ...(row.title !== null && { title: row.title }),
    ...(row.entity_ref !== null && { entityRef: row.entity_ref }),
    enabledToolsets: JSON.parse(row.enabled_toolsets),
    ...(row.forked_from_session !== null &&
      row.forked_from_seq !== null && {
        forkedFrom: {
          sessionId: row.forked_from_session,
          seq: row.forked_from_seq,
        },
      }),
    pinned: Boolean(row.pinned),
    ...(row.archived_at !== null && { archivedAt: row.archived_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

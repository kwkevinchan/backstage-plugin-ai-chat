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
  RunAlreadyActive,
  SessionNotFound,
  normalizeSearchQuery,
  searchLikePattern,
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

/** How often a delete starts over when a run is inserted while it locks. */
const DELETE_ATTEMPTS = 8;

/** Rolls the delete back so it can lock the new run before the session. */
class DeleteRestart extends Error {
  constructor() {
    super('A run was inserted while the session was being deleted');
    this.name = 'DeleteRestart';
  }
}

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
    opts: { includeArchived?: boolean; limit?: number; query?: string } = {},
  ): Promise<Session[]> {
    const query = this.knex<SessionRow>('sessions').where({
      owner_ref: ownerRef,
    });
    if (!opts.includeArchived) query.whereNull('archived_at');
    // Same rule as `sessionMatchesSearch`: the stored title, ASCII case
    // folded. `%` and `_` in the query are ordinary characters.
    if (normalizeSearchQuery(opts.query).length > 0) {
      query.whereRaw("lower(title) like ? escape '!'", [
        searchLikePattern(opts.query ?? ''),
      ]);
    }
    query.orderBy([
      { column: 'pinned', order: 'desc' },
      { column: 'updated_at', order: 'desc' },
      { column: 'id', order: 'asc' },
    ]);
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

  async setTitleIfAbsent(sessionId: string, title: string): Promise<boolean> {
    const now = this.clock.now().toISOString();
    const count = await this.knex('sessions')
      .where({ id: sessionId })
      .whereNull('title')
      .update({ title, updated_at: now });
    return count > 0;
  }

  /**
   * Deletes the session and, through the foreign keys, its runs, items,
   * queued messages and images.
   *
   * The runs are locked first (`FOR UPDATE`, one row at a time, in the order
   * of `id`), and the session after them. A plain `DELETE` locks the session
   * and only then the runs, which is the opposite of an append (the run, then
   * the session): each would wait for the lock the other holds. A run that is
   * inserted after the runs were locked makes this attempt roll back and
   * start over, so the session lock is never held while waiting for that run.
   */
  async delete(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
      try {
        await this.knex.transaction(async trx => {
          const held = await lockRuns(trx, sessionId);
          const session = await trx('sessions')
            .where({ id: sessionId })
            .forUpdate()
            .first('id');
          if (!session) throw new SessionNotFound(sessionId);
          const now = await runIds(trx, sessionId);
          if (!sameIds(held, now)) throw new DeleteRestart();
          const count = await trx('sessions').where({ id: sessionId }).delete();
          if (count === 0) throw new SessionNotFound(sessionId);
        });
        return;
      } catch (error) {
        if (
          attempt < DELETE_ATTEMPTS - 1 &&
          (error instanceof DeleteRestart || isDeadlock(error))
        ) {
          continue;
        }
        if (error instanceof DeleteRestart) {
          throw new RunAlreadyActive(sessionId);
        }
        throw error;
      }
    }
  }
}

async function lockRuns(
  trx: Knex.Transaction,
  sessionId: string,
): Promise<string[]> {
  const ids = await runIds(trx, sessionId);
  for (const id of ids) {
    await trx('runs').where({ id }).forUpdate().first('id');
  }
  return ids;
}

async function runIds(
  trx: Knex.Transaction,
  sessionId: string,
): Promise<string[]> {
  const rows: { id: string }[] = await trx('runs')
    .where({ session_id: sessionId })
    .orderBy('id', 'asc')
    .select('id');
  return rows.map(row => row.id);
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function isDeadlock(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '40P01'
  );
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

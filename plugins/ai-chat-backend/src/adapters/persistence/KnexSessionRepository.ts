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
import { isPostgres } from './postgres';
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
    opts: {
      includeArchived?: boolean;
      limit?: number;
      query?: string;
      entityRef?: string;
    } = {},
  ): Promise<Session[]> {
    const query = this.knex<SessionRow>('sessions').where({
      owner_ref: ownerRef,
    });
    if (!opts.includeArchived) query.whereNull('archived_at');
    if (opts.entityRef !== undefined) {
      query.where({ entity_ref: opts.entityRef });
    }
    // JS only trims the query. Both sides of LIKE use SQL lower(), so
    // SQLite and PostgreSQL apply the same function. `%` and `_` in the
    // query are ordinary characters.
    if (normalizeSearchQuery(opts.query).length > 0) {
      query.whereRaw("lower(title) like lower(?) escape '!'", [
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

  async bindEntityIfUnbound(
    sessionId: string,
    entityRef: string,
  ): Promise<boolean> {
    const now = this.clock.now().toISOString();
    const count = await this.knex('sessions')
      .where({ id: sessionId })
      .whereNull('entity_ref')
      .update({ entity_ref: entityRef, updated_at: now });
    return count > 0;
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

  /**
   * Deletes sessions last changed strictly before `olderThan`, except one
   * whose run has not ended (SE-05). Each session is its own transaction, in
   * the same lock order as `delete`: its runs first (`id` order), then the
   * session. On PostgreSQL a row another transaction holds is skipped
   * (`SKIP LOCKED`), so two purges do not delete one session twice and do not
   * wait on each other. A run inserted after the runs were locked rolls this
   * session's attempt back and starts it again.
   */
  async purgeExpired(olderThan: Date): Promise<number> {
    const cutoff = olderThan.toISOString();
    const candidates: { id: string }[] = await this.knex('sessions')
      .where('updated_at', '<', cutoff)
      .orderBy('id', 'asc')
      .select('id');
    let deleted = 0;
    for (const { id } of candidates) {
      if (await deleteExpired(this.knex, id, cutoff)) deleted += 1;
    }
    return deleted;
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

/**
 * Deletes one session when it is still older than `cutoff` and has no run
 * that has not ended. Returns false when it is left in place: it is gone,
 * newer, busy with a run, or a row of it is held by another transaction.
 */
async function deleteExpired(
  knex: Knex,
  sessionId: string,
  cutoff: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
    try {
      return await knex.transaction(async trx => {
        const held = await lockRunsSkipLocked(trx, sessionId);
        // Another transaction holds a run of this session. Leave it for the
        // next purge instead of waiting.
        if (!held) return false;
        const current = await runIds(trx, sessionId);
        if (!sameIds(held, current)) throw new DeleteRestart();
        const active = await trx('runs')
          .where({ active_session_id: sessionId })
          .first('id');
        if (active) return false;

        const sessionQuery = trx('sessions')
          .where({ id: sessionId })
          .andWhere('updated_at', '<', cutoff);
        const session = await (isPostgres(trx)
          ? sessionQuery.forUpdate().skipLocked()
          : sessionQuery.forUpdate()
        ).first('id');
        // Gone, changed since the list, or held by another transaction.
        if (!session) return false;
        const after = await runIds(trx, sessionId);
        if (!sameIds(held, after)) throw new DeleteRestart();
        const count = await trx('sessions').where({ id: sessionId }).delete();
        return count > 0;
      });
    } catch (error) {
      if (
        attempt < DELETE_ATTEMPTS - 1 &&
        (error instanceof DeleteRestart || isDeadlock(error))
      ) {
        continue;
      }
      // One busy session does not fail the purge of the others. The next
      // hour tries it again.
      if (error instanceof DeleteRestart || isDeadlock(error)) return false;
      throw error;
    }
  }
  return false;
}

/**
 * Locks the runs of a session in `id` order. Returns their ids, or undefined
 * when one of them is held by another transaction (PostgreSQL skips it).
 */
async function lockRunsSkipLocked(
  trx: Knex.Transaction,
  sessionId: string,
): Promise<string[] | undefined> {
  const ids = await runIds(trx, sessionId);
  const held: string[] = [];
  for (const id of ids) {
    const query = trx('runs').where({ id });
    const row = await (isPostgres(trx)
      ? query.forUpdate().skipLocked()
      : query.forUpdate()
    ).first('id');
    if (!row) return undefined;
    held.push(row.id);
  }
  return held;
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

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

import type { Knex } from 'knex';

/**
 * Refuses a SQLite pool that can open more than one connection.
 *
 * Knex compiles `FOR UPDATE`, `FOR SHARE` and `FOR NO KEY UPDATE` to nothing
 * on SQLite, and its default pool for SQLite is one connection, so the
 * transactions of one file go one after the other. A second connection does
 * not wait in that order: the transaction that writes second can fail with
 * `SQLITE_BUSY`, and a run that should have kept going (an insert arrived
 * before it ended) can be marked failed. PostgreSQL is the client that has
 * the row locks. Call this when the plugin starts, before it migrates.
 */
export function assertSingleSqliteConnection(knex: Knex): void {
  const client = String(knex.client.config.client ?? '');
  if (client !== 'sqlite3' && client !== 'better-sqlite3') return;
  const max = knex.client.pool?.max;
  if (max === 1) return;
  throw new Error(
    `The AI chat plugin supports one SQLite connection, and this pool allows ${max}. ` +
      'SQLite does not take the row locks the plugin uses, so a second connection can fail a transaction with SQLITE_BUSY instead of the result those locks define. ' +
      'Leave the SQLite pool at its default (min 1, max 1), or use PostgreSQL.',
  );
}

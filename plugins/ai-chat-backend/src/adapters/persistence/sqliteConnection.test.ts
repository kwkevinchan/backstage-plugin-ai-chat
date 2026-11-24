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

import knex from 'knex';
import type { Knex } from 'knex';
import { assertSingleSqliteConnection } from './sqliteConnection';

describe('assertSingleSqliteConnection', () => {
  it('accepts the default SQLite pool of one connection', async () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    try {
      expect(db.client.pool.max).toBe(1);
      expect(() => assertSingleSqliteConnection(db)).not.toThrow();
    } finally {
      await db.destroy();
    }
  });

  it('refuses a SQLite pool that allows a second connection', async () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 2 },
      useNullAsDefault: true,
    });
    try {
      expect(() => assertSingleSqliteConnection(db)).toThrow(
        /one SQLite connection/,
      );
    } finally {
      await db.destroy();
    }
  });

  it('does not look at the pool of another client', () => {
    const db = {
      client: { config: { client: 'pg' }, pool: { max: 10 } },
    } as unknown as Knex;
    expect(() => assertSingleSqliteConnection(db)).not.toThrow();
  });
});

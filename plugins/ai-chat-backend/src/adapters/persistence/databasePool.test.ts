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

import { createPersistence } from './__testUtils__';

/**
 * V-10. The design of the end of a run relies on what the pool of connections
 * does: with SQLite the transactions go one after the other on one connection
 * (knex sets `min: 1, max: 1` for it), so there is no race to test; with
 * PostgreSQL they run on separate connections and the locks decide. The tests
 * of the races (`postgresConcurrency.test.ts`) mean nothing if the pool had one
 * connection, so this checks the pool of the database the tests run on.
 */
const onPostgres = Boolean(
  process.env.BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING,
);
const itSqlite = onPostgres ? it.skip : it;
const itPostgres = onPostgres ? it : it.skip;

describe('the connections of the database of the tests (V-10)', () => {
  itSqlite('SQLite has one connection, so its transactions queue', async () => {
    const p = await createPersistence();
    try {
      expect(p.knex.client.pool.min).toBe(1);
      expect(p.knex.client.pool.max).toBe(1);
    } finally {
      await p.cleanup();
    }
  });

  itPostgres('PostgreSQL has more than one connection', async () => {
    const p = await createPersistence();
    try {
      expect(p.knex.client.pool.max).toBeGreaterThanOrEqual(2);
    } finally {
      await p.cleanup();
    }
  });
});

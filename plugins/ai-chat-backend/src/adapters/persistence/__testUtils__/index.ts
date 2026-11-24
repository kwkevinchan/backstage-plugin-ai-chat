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

import {
  FakeClock,
  SequentialIdGenerator,
} from '@kwkevinchan/ai-chat-harness/testing';
import { createMigratedDb } from '../../../__testUtils__';
import { KnexItemLog } from '../KnexItemLog';
import { KnexQueuedMessageRepository } from '../KnexQueuedMessageRepository';
import { KnexRunRepository } from '../KnexRunRepository';
import { KnexSessionRepository } from '../KnexSessionRepository';

/**
 * A migrated database (SQLite, or PostgreSQL 16 when CI sets it; see
 * `createMigratedDb`) with the three repositories on it. `newRuns()` is another
 * backend on the same database.
 */
export async function createPersistence() {
  const knex = await createMigratedDb();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator('id');
  // Another backend on the same database.
  const newRuns = (leaseSeconds?: number) =>
    new KnexRunRepository(knex, clock, ids, { leaseSeconds });
  return {
    knex,
    clock,
    ids,
    sessions: new KnexSessionRepository(knex, clock, ids),
    runs: newRuns(),
    newRuns,
    items: new KnexItemLog(knex, clock),
    queue: new KnexQueuedMessageRepository(knex, clock, ids),
    cleanup: () => knex.destroy(),
  };
}

export const NEW_SESSION = {
  ownerRef: 'user:default/jane',
  agentId: 'default',
};

/**
 * The message of the database error that a query ends in. An error of the
 * database driver can come from outside the realm of the test, where
 * `rejects.toThrow()` does not recognise it, so the tests read its message.
 */
export async function databaseErrorOf(query: PromiseLike<unknown>) {
  try {
    await query;
  } catch (error) {
    return String((error as { message?: unknown }).message);
  }
  throw new Error('The query was expected to fail and did not');
}

/** What the databases say when a unique index or a foreign key refuses a row. */
export const CONSTRAINT_ERROR = /unique|duplicate key|foreign key/i;

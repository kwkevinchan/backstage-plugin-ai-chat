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

import { resolvePackagePath } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import { createDb, createMigratedDb } from '../../__testUtils__';
import { KnexWriteQuota } from './KnexWriteQuota';

describe('KnexWriteQuota (T-10)', () => {
  let knex: Knex;

  beforeEach(async () => {
    knex = await createMigratedDb();
  });

  afterEach(async () => {
    await knex.destroy();
  });

  const at = (time: string) => new Date(`2026-01-01T${time}.000Z`);
  const jane = 'user:default/jane';

  it('gives perMinute changes to a user in a minute, then none until the next minute', async () => {
    const quota = new KnexWriteQuota(knex);
    const taken = [];
    for (let i = 0; i < 3; i++) {
      taken.push(await quota.tryTake(jane, 2, at('00:00:10')));
    }
    expect(taken).toEqual([true, true, false]);
    expect(await quota.tryTake(jane, 2, at('00:00:59'))).toBe(false);
    expect(await quota.tryTake(jane, 2, at('00:01:00'))).toBe(true);
  });

  it('counts each user on their own', async () => {
    const quota = new KnexWriteQuota(knex);
    expect(await quota.tryTake(jane, 1, at('00:00:00'))).toBe(true);
    expect(await quota.tryTake(jane, 1, at('00:00:01'))).toBe(false);
    expect(await quota.tryTake('user:default/bob', 1, at('00:00:02'))).toBe(
      true,
    );
  });

  it('shares the changes with another backend on the same database', async () => {
    const a = new KnexWriteQuota(knex);
    const b = new KnexWriteQuota(knex);
    expect(await a.tryTake(jane, 1, at('00:00:00'))).toBe(true);
    expect(await b.tryTake(jane, 1, at('00:00:30'))).toBe(false);
  });

  it('deletes the rows of the minutes before the current one', async () => {
    const quota = new KnexWriteQuota(knex);
    await quota.tryTake(jane, 5, at('00:00:00'));
    await quota.tryTake('user:default/bob', 5, at('00:00:10'));
    await quota.tryTake(jane, 5, at('00:02:00'));
    const rows = await knex('write_quota_windows').select(
      'user_ref',
      'window_start',
      'writes',
    );
    expect(rows).toEqual([
      { user_ref: jane, window_start: '2026-01-01T00:02:00.000Z', writes: 1 },
    ]);
  });
});

describe('the migration of the quota of changes', () => {
  const config = {
    directory: resolvePackagePath(
      '@kwkevinchan/backstage-plugin-ai-chat-backend',
      'migrations',
    ),
  };

  it('adds the table, and undoing it drops only that table', async () => {
    const knex = await createDb();
    try {
      await knex.migrate.latest(config);
      expect(await knex.schema.hasTable('write_quota_windows')).toBe(true);
      // The migration of the references comes after this one.
      await knex.migrate.down(config);
      await knex.migrate.down(config);
      expect(await knex.schema.hasTable('write_quota_windows')).toBe(false);
      expect(await knex.schema.hasTable('model_call_windows')).toBe(true);
      expect(await knex.schema.hasTable('sessions')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });
});

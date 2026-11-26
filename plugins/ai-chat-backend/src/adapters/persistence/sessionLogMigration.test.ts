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
import { createMigratedDb } from '../../__testUtils__';
import { CONSTRAINT_ERROR, databaseErrorOf } from './__testUtils__';

const NOW = '2026-01-01T00:00:00.000Z';

const session = (id: string) => ({
  id,
  owner_ref: 'user:default/jane',
  agent_id: 'default',
  enabled_toolsets: '[]',
  created_at: NOW,
  updated_at: NOW,
});

const run = (id: string, sessionId: string, active: string | null) => ({
  id,
  session_id: sessionId,
  status: active ? 'running' : 'completed',
  active_session_id: active,
  started_at: NOW,
});

const item = (sessionId: string, seq: number, dedupeKey: string | null) => ({
  session_id: sessionId,
  seq,
  kind: 'note',
  payload: '{}',
  dedupe_key: dedupeKey,
  created_at: NOW,
});

/**
 * V-03: the unique indexes hold a column that is null for most rows. These
 * tests run on SQLite, and on PostgreSQL 16 in CI, and say the same on both:
 * a null never conflicts, a value does.
 */
describe('the migration of the session log', () => {
  let knex: Awaited<ReturnType<typeof createMigratedDb>>;

  beforeEach(async () => {
    knex = await createMigratedDb();
    await knex('sessions').insert([session('s1'), session('s2')]);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('allows any number of runs with a null active_session_id in one session (V-03)', async () => {
    await knex('runs').insert([
      run('r1', 's1', null),
      run('r2', 's1', null),
      run('r3', 's1', null),
    ]);
    const [{ count }] = await knex('runs')
      .where({ session_id: 's1' })
      .count({ count: '*' });
    expect(Number(count)).toBe(3);
  });

  it('allows a run with a null next to the active run of the same session (V-03)', async () => {
    await knex('runs').insert([run('r1', 's1', 's1'), run('r2', 's1', null)]);
    await expect(
      databaseErrorOf(knex('runs').insert(run('r3', 's1', 's1'))),
    ).resolves.toMatch(CONSTRAINT_ERROR);
    // Another session can have an active run at the same time.
    await knex('runs').insert(run('r4', 's2', 's2'));
  });

  it('allows any number of items with a null dedupe_key in one session, and refuses an equal key (V-03)', async () => {
    await knex('items').insert([
      item('s1', 1, null),
      item('s1', 2, null),
      item('s1', 3, 'tool_call:c1'),
      item('s1', 4, 'approval:c1'),
      item('s2', 1, 'tool_call:c1'),
    ]);
    await expect(
      databaseErrorOf(knex('items').insert(item('s1', 5, 'tool_call:c1'))),
    ).resolves.toMatch(CONSTRAINT_ERROR);
    await expect(
      databaseErrorOf(knex('items').insert(item('s1', 3, null))),
    ).resolves.toMatch(CONSTRAINT_ERROR);
  });

  it('can be undone, which leaves the tables of the first version', async () => {
    const config = {
      directory: resolvePackagePath(
        '@kwkevinchan/backstage-plugin-ai-chat-backend',
        'migrations',
      ),
    };
    // Five later migrations come first: the model calls, the shares, the
    // attachments, the tables of the input phase, and the one that drops the
    // tables of the first version (undoing it brings them back). Undoing this one drops
    // the tables of the log.
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    for (const table of ['sessions', 'runs', 'items']) {
      expect(await knex.schema.hasTable(table)).toBe(false);
    }
    expect(await knex.schema.hasTable('conversations')).toBe(true);
  });
});

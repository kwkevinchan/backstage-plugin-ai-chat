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
import { createDb } from '../../__testUtils__';

const config = {
  directory: resolvePackagePath(
    '@kwkevinchan/backstage-plugin-ai-chat-backend',
    'migrations',
  ),
};
const OLD_TABLES = ['conversations', 'messages', 'tool_calls'];
const NEW_TABLES = ['sessions', 'runs', 'items'];

describe('the migration that drops the tables of the first version', () => {
  let knex: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    knex = await createDb();
  });

  afterEach(async () => {
    await knex.destroy();
  });

  const has = async (tables: string[]) =>
    Promise.all(tables.map(table => knex.schema.hasTable(table)));

  it('drops the old tables with their rows and keeps the tables of the session log', async () => {
    // The first two migrations: the old tables, and the tables of the log.
    await knex.migrate.up(config);
    await knex.migrate.up(config);
    expect(await has([...OLD_TABLES, ...NEW_TABLES])).toEqual(
      Array(6).fill(true),
    );
    await knex('conversations').insert({
      id: 'c1',
      user_entity_ref: 'user:default/jane',
      title: 'Old',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await knex('sessions').insert({
      id: 's1',
      owner_ref: 'user:default/jane',
      agent_id: 'default',
      enabled_toolsets: '[]',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    await knex.migrate.latest(config);

    expect(await has(OLD_TABLES)).toEqual([false, false, false]);
    expect(await has(NEW_TABLES)).toEqual([true, true, true]);
    // The old rows are not moved to the new tables.
    expect(await knex('sessions').select('id')).toEqual([{ id: 's1' }]);
  });

  it('runs on a fresh database, and rolling it back brings the old tables back empty', async () => {
    await knex.migrate.latest(config);
    expect(await has(OLD_TABLES)).toEqual([false, false, false]);

    // Rolling back brings the three tables back, empty. The migrations of the
    // shares, the attachments, the input phase, the model calls, the write
    // quota and the references come after it: they go first.
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    expect(await has(OLD_TABLES)).toEqual([true, true, true]);
    expect(await knex('conversations').count({ n: '*' })).toHaveLength(1);
    expect(Number((await knex('conversations').count({ n: '*' }))[0].n)).toBe(
      0,
    );

    await knex.migrate.latest(config);
    expect(await has(OLD_TABLES)).toEqual([false, false, false]);
  });
});

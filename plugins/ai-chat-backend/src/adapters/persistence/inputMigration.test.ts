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

describe('the migration of the input phase', () => {
  let knex: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    knex = await createDb();
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('adds read_up_to_seq to the runs that exist, starting at 0, and the table of the queue', async () => {
    // Everything before the migration of the input phase.
    for (let i = 0; i < 3; i++) await knex.migrate.up(config);
    expect(await knex.schema.hasTable('queued_messages')).toBe(false);
    await knex('sessions').insert({
      id: 's1',
      owner_ref: 'user:default/jane',
      agent_id: 'default',
      enabled_toolsets: '[]',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await knex('runs').insert({
      id: 'r1',
      session_id: 's1',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
    });

    await knex.migrate.up(config);

    expect(await knex.schema.hasColumn('runs', 'read_up_to_seq')).toBe(true);
    expect(
      (await knex('runs').where({ id: 'r1' }).first('read_up_to_seq'))
        .read_up_to_seq,
    ).toBe(0);
    await knex('queued_messages').insert({
      id: 'q1',
      session_id: 's1',
      position: 1,
      text: 'Next',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const row = await knex('queued_messages').where({ id: 'q1' }).first();
    expect(row).toMatchObject({ attachment_ids: '[]', page: null });
  });

  it('removes the queue of a session with the session', async () => {
    await knex.migrate.latest(config);
    await knex('sessions').insert({
      id: 's1',
      owner_ref: 'user:default/jane',
      agent_id: 'default',
      enabled_toolsets: '[]',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await knex('queued_messages').insert({
      id: 'q1',
      session_id: 's1',
      position: 1,
      text: 'Next',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await knex('sessions').where({ id: 's1' }).delete();
    expect(await knex('queued_messages').select('id')).toEqual([]);
  });

  it('can be undone: the queue table and the column go, and the rest stays', async () => {
    await knex.migrate.latest(config);
    // The migration of the attachments comes after this one.
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    expect(await knex.schema.hasTable('queued_messages')).toBe(false);
    expect(await knex.schema.hasColumn('runs', 'read_up_to_seq')).toBe(false);
    expect(await knex.schema.hasTable('runs')).toBe(true);
    await knex.migrate.latest(config);
    expect(await knex.schema.hasTable('queued_messages')).toBe(true);
  });
});

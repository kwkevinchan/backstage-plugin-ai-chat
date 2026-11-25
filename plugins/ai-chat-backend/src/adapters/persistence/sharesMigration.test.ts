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
import { createDb } from '../../__testUtils__';

const config = {
  directory: resolvePackagePath(
    '@kwkevinchan/backstage-plugin-ai-chat-backend',
    'migrations',
  ),
};

const NOW = '2026-01-01T00:00:00.000Z';

const COLUMNS = [
  'created_at',
  'created_by',
  'expires_at',
  'id',
  'outputs_up_to_seq',
  'revoked_at',
  'session_id',
  'subject_ref',
  'up_to_seq',
];

describe('the migration of the shares', () => {
  let knex: Knex;

  beforeEach(async () => {
    knex = await createDb();
  });

  afterEach(async () => {
    await knex.destroy();
  });

  async function session(id = 's1') {
    await knex('sessions').insert({
      id,
      owner_ref: 'user:default/jane',
      agent_id: 'default',
      enabled_toolsets: '[]',
      created_at: NOW,
      updated_at: NOW,
    });
  }

  const row = (id: string, sessionId = 's1', subject = 'user:default/bob') => ({
    id,
    session_id: sessionId,
    subject_ref: subject,
    created_by: 'user:default/jane',
    created_at: NOW,
  });

  it('creates exactly the columns of a share, with no write permission, and indexes session_id and subject_ref', async () => {
    await knex.migrate.latest(config);
    const info = await knex('shares').columnInfo();
    expect(Object.keys(info).sort()).toEqual(COLUMNS);
    for (const name of [
      'up_to_seq',
      'outputs_up_to_seq',
      'expires_at',
      'revoked_at',
    ]) {
      expect(info[name].nullable).toBe(true);
    }
    for (const name of [
      'id',
      'session_id',
      'subject_ref',
      'created_by',
      'created_at',
    ]) {
      expect(info[name].nullable).toBe(false);
    }
    expect(info).not.toHaveProperty('role');
    const indexes = await indexSql(knex);
    expect(indexes).toMatch(/session_id/);
    expect(indexes).toMatch(/subject_ref/);
  });

  it('stores a null seq, a null output bound, a null expiry and a null revocation, and a user or group ref', async () => {
    await knex.migrate.latest(config);
    await session();
    await knex('shares').insert([
      row('sh1', 's1', 'user:default/bob'),
      row('sh2', 's1', 'group:default/platform'),
    ]);
    const stored = await knex('shares').orderBy('id').select();
    expect(stored).toEqual([
      {
        ...row('sh1'),
        up_to_seq: null,
        outputs_up_to_seq: null,
        expires_at: null,
        revoked_at: null,
      },
      {
        ...row('sh2', 's1', 'group:default/platform'),
        up_to_seq: null,
        outputs_up_to_seq: null,
        expires_at: null,
        revoked_at: null,
      },
    ]);
  });

  it('removes the shares of a session when the session is deleted', async () => {
    await knex.migrate.latest(config);
    await session();
    await knex('shares').insert(row('sh1'));
    await knex('sessions').where({ id: 's1' }).delete();
    expect(await knex('shares').select('id')).toEqual([]);
  });

  it('refuses a share for a session that is not there', async () => {
    await knex.migrate.latest(config);
    await expect(
      Promise.resolve(knex('shares').insert(row('sh1', 'none'))).then(
        () => 'inserted',
        () => 'refused',
      ),
    ).resolves.toBe('refused');
  });

  it('can be undone: the shares table goes and the rest stays', async () => {
    await knex.migrate.latest(config);
    await session();
    await knex('shares').insert(row('sh1'));
    await knex.migrate.down(config);
    expect(await knex.schema.hasTable('shares')).toBe(false);
    expect(await knex.schema.hasTable('sessions')).toBe(true);
    expect(await knex.schema.hasTable('attachments')).toBe(true);
    expect(await knex.schema.hasTable('queued_messages')).toBe(true);
    expect(await knex('sessions').select('id')).toEqual([{ id: 's1' }]);
    await knex.migrate.latest(config);
    expect(await knex.schema.hasTable('shares')).toBe(true);
  });
});

/** The SQL of the indexes on `shares`, on SQLite and on PostgreSQL. */
async function indexSql(knex: Knex): Promise<string> {
  if (knex.client.config.client === 'better-sqlite3') {
    const rows = await knex('sqlite_master')
      .where({ type: 'index', tbl_name: 'shares' })
      .select('sql');
    return rows.map(entry => String(entry.sql ?? '')).join('\n');
  }
  const rows = await knex('pg_indexes')
    .where({ tablename: 'shares' })
    .select('indexdef');
  return rows.map(entry => String(entry.indexdef)).join('\n');
}

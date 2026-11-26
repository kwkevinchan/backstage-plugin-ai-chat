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

describe('the migration of the attachments', () => {
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

  const attachment = (id: string, sessionId = 's1') => ({
    id,
    session_id: sessionId,
    owner_ref: 'user:default/jane',
    media_type: 'image/png',
    size: 3,
    sha256: 'x'.repeat(64),
    name: 'a.png',
    bytes: Buffer.from([1, 2, 3]),
    created_at: NOW,
  });

  it('makes the table, with the bytes and with no use and no hold', async () => {
    await knex.migrate.latest(config);
    await session();
    await knex('attachments').insert(attachment('a1'));
    const row = await knex('attachments').where({ id: 'a1' }).first();
    expect(row).toMatchObject({ used_seq: null, reserved_by: null, size: 3 });
    expect(Buffer.from(row.bytes)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('removes the images of a session with the session', async () => {
    await knex.migrate.latest(config);
    await session();
    await knex('attachments').insert(attachment('a1'));
    await knex('sessions').where({ id: 's1' }).delete();
    expect(await knex('attachments').select('id')).toEqual([]);
  });

  it('does not take an image for a session that is not there', async () => {
    await knex.migrate.latest(config);
    await expect(
      Promise.resolve(
        knex('attachments').insert(attachment('a1', 'none')),
      ).then(
        () => 'inserted',
        () => 'refused',
      ),
    ).resolves.toBe('refused');
  });

  it('can be undone: the table goes and the rest stays', async () => {
    await knex.migrate.latest(config);
    // The migrations of the shares, of the model calls and of the write quota
    // come after this one.
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    await knex.migrate.down(config);
    expect(await knex.schema.hasTable('attachments')).toBe(false);
    expect(await knex.schema.hasTable('queued_messages')).toBe(true);
    await knex.migrate.latest(config);
    expect(await knex.schema.hasTable('attachments')).toBe(true);
  });
});

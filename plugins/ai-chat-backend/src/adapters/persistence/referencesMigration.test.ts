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

describe('the migration of the references of queued messages', () => {
  const config = {
    directory: resolvePackagePath(
      '@kwkevinchan/backstage-plugin-ai-chat-backend',
      'migrations',
    ),
  };

  it('adds the column, empty for a message queued before, and undoing it drops only that column', async () => {
    const knex = await createDb();
    try {
      const all = (await knex.migrate.list(config))[1] as unknown[];
      for (let i = 1; i < all.length; i++) await knex.migrate.up(config);
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
        text: 'later',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      await knex.migrate.up(config);
      expect(
        await knex.schema.hasColumn('queued_messages', 'message_references'),
      ).toBe(true);
      expect(
        await knex('queued_messages').first('text', 'message_references'),
      ).toEqual({ text: 'later', message_references: null });

      await knex.migrate.down(config);
      expect(
        await knex.schema.hasColumn('queued_messages', 'message_references'),
      ).toBe(false);
      expect(await knex('queued_messages').first('text')).toEqual({
        text: 'later',
      });
      expect(await knex.schema.hasTable('write_quota_windows')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });
});

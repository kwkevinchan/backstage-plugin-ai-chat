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

import { SessionNotFound } from '../../domain';
import { NEW_SESSION, createPersistence } from './__testUtils__';

describe('KnexSessionRepository', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;

  beforeEach(async () => {
    p = await createPersistence();
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('creates a session with its defaults and reads it back', async () => {
    const created = await p.sessions.create(NEW_SESSION);
    expect(created).toEqual({
      id: created.id,
      ownerRef: 'user:default/jane',
      agentId: 'default',
      enabledToolsets: [],
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await p.sessions.get(created.id)).toEqual(created);
  });

  it('keeps the optional fields, the toolsets and the fork origin', async () => {
    const created = await p.sessions.create({
      ...NEW_SESSION,
      title: 'Why is the build red',
      entityRef: 'component:default/shop',
      enabledToolsets: ['catalog', 'scaffolder'],
      forkedFrom: { sessionId: 'session-9', seq: 12 },
    });
    expect(await p.sessions.get(created.id)).toMatchObject({
      title: 'Why is the build red',
      entityRef: 'component:default/shop',
      enabledToolsets: ['catalog', 'scaffolder'],
      forkedFrom: { sessionId: 'session-9', seq: 12 },
    });
  });

  it('throws SessionNotFound for a session that does not exist', async () => {
    await expect(p.sessions.get('nope')).rejects.toBeInstanceOf(
      SessionNotFound,
    );
    await expect(
      p.sessions.update('nope', { pinned: true }),
    ).rejects.toBeInstanceOf(SessionNotFound);
    await expect(p.sessions.delete('nope')).rejects.toBeInstanceOf(
      SessionNotFound,
    );
  });

  it('updates the fields of the patch only, and the time', async () => {
    const created = await p.sessions.create({ ...NEW_SESSION, title: 'old' });
    p.clock.advance(10);
    const updated = await p.sessions.update(created.id, {
      pinned: true,
      enabledToolsets: ['catalog'],
    });
    expect(updated).toMatchObject({
      title: 'old',
      pinned: true,
      enabledToolsets: ['catalog'],
      updatedAt: '2026-01-01T00:00:10.000Z',
    });
    const renamed = await p.sessions.update(created.id, { title: null });
    expect(renamed.title).toBeUndefined();
  });

  it('archives and restores a session', async () => {
    const created = await p.sessions.create(NEW_SESSION);
    p.clock.advance(5);
    const archived = await p.sessions.update(created.id, { archived: true });
    expect(archived.archivedAt).toBe('2026-01-01T00:00:05.000Z');
    const restored = await p.sessions.update(created.id, { archived: false });
    expect(restored.archivedAt).toBeUndefined();
  });

  it('lists the sessions of one owner, newest update first, without the archived ones', async () => {
    const first = await p.sessions.create(NEW_SESSION);
    p.clock.advance(1);
    const second = await p.sessions.create(NEW_SESSION);
    p.clock.advance(1);
    const archived = await p.sessions.create(NEW_SESSION);
    await p.sessions.update(archived.id, { archived: true });
    await p.sessions.create({ ...NEW_SESSION, ownerRef: 'user:default/joe' });
    p.clock.advance(1);
    await p.sessions.update(first.id, { pinned: true });

    const list = await p.sessions.listByOwner('user:default/jane');
    expect(list.map(s => s.id)).toEqual([first.id, second.id]);
    expect(
      (await p.sessions.listByOwner('user:default/jane', { limit: 1 })).map(
        s => s.id,
      ),
    ).toEqual([first.id]);
    expect(
      await p.sessions.listByOwner('user:default/jane', {
        includeArchived: true,
      }),
    ).toHaveLength(3);
  });

  it('deletes a session and what belongs to it', async () => {
    const created = await p.sessions.create(NEW_SESSION);
    await p.runs.start(created.id);
    await p.sessions.delete(created.id);
    await expect(p.sessions.get(created.id)).rejects.toBeInstanceOf(
      SessionNotFound,
    );
    expect(await p.knex('runs').where({ session_id: created.id })).toEqual([]);
  });
});

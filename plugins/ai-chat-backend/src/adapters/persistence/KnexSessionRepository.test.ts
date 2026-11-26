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

import { IMAGES } from '../../__testUtils__/images';
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

  it('lists a pinned session before a newer one that is not pinned', async () => {
    const older = await p.sessions.create({ ...NEW_SESSION, title: 'older' });
    await p.sessions.update(older.id, { pinned: true });
    p.clock.advance(5);
    const newer = await p.sessions.create({ ...NEW_SESSION, title: 'newer' });

    expect(
      (await p.sessions.listByOwner('user:default/jane')).map(s => s.id),
    ).toEqual([older.id, newer.id]);
  });

  it('searches titles, skips a session with none, and treats % and _ as letters', async () => {
    const plain = await p.sessions.create({
      ...NEW_SESSION,
      title: 'Build is red',
    });
    p.clock.advance(1);
    const percent = await p.sessions.create({
      ...NEW_SESSION,
      title: '100%_done',
    });
    p.clock.advance(1);
    await p.sessions.create(NEW_SESSION);
    const owner = 'user:default/jane';
    const ids = async (query?: string) =>
      (await p.sessions.listByOwner(owner, { query })).map(s => s.id);

    expect(await ids('BUILD')).toEqual([plain.id]);
    expect(await ids('  ')).toEqual(await ids());
    expect(await ids('100%')).toEqual([percent.id]);
    expect(await ids('100%_')).toEqual([percent.id]);
    expect(await ids('_')).toEqual([percent.id]);
    expect(await ids('100X')).toEqual([]);
    expect(await ids('red')).toEqual([plain.id]);
  });

  it('matches a non-ASCII capital in the title the same way on both databases', async () => {
    const umlaut = await p.sessions.create({
      ...NEW_SESSION,
      title: 'Über build',
    });
    const owner = 'user:default/jane';
    const ids = async (query: string) =>
      (await p.sessions.listByOwner(owner, { query })).map(s => s.id);

    // The same letters as stored, and an ASCII substring: both sides of LIKE
    // use SQL lower(), so this holds on SQLite and on PostgreSQL.
    expect(await ids('Über')).toEqual([umlaut.id]);
    expect(await ids('build')).toEqual([umlaut.id]);
  });

  it('setTitleIfAbsent writes only while the title is empty', async () => {
    const created = await p.sessions.create(NEW_SESSION);
    expect(await p.sessions.setTitleIfAbsent(created.id, 'Generated')).toBe(
      true,
    );
    expect((await p.sessions.get(created.id)).title).toBe('Generated');
    expect(await p.sessions.setTitleIfAbsent(created.id, 'Other')).toBe(false);
    expect((await p.sessions.get(created.id)).title).toBe('Generated');
    await p.sessions.update(created.id, { title: 'Mine' });
    expect(await p.sessions.setTitleIfAbsent(created.id, 'Other')).toBe(false);
    expect((await p.sessions.get(created.id)).title).toBe('Mine');
    expect(await p.sessions.setTitleIfAbsent('missing', 'x')).toBe(false);
  });

  it('bindEntityIfUnbound binds a session once, and never changes the binding (SE-02)', async () => {
    const created = await p.sessions.create(NEW_SESSION);
    p.clock.advance(60);
    expect(
      await p.sessions.bindEntityIfUnbound(
        created.id,
        'component:default/shop',
      ),
    ).toBe(true);
    expect(await p.sessions.get(created.id)).toMatchObject({
      entityRef: 'component:default/shop',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    expect(
      await p.sessions.bindEntityIfUnbound(
        created.id,
        'component:default/other',
      ),
    ).toBe(false);
    expect((await p.sessions.get(created.id)).entityRef).toBe(
      'component:default/shop',
    );
    const bound = await p.sessions.create({
      ...NEW_SESSION,
      entityRef: 'component:default/a',
    });
    expect(
      await p.sessions.bindEntityIfUnbound(bound.id, 'component:default/b'),
    ).toBe(false);
    expect(
      await p.sessions.bindEntityIfUnbound('missing', 'component:default/b'),
    ).toBe(false);
  });

  it('lists only the sessions bound to an entity, with the other filters (SE-06)', async () => {
    const shop = await p.sessions.create({
      ...NEW_SESSION,
      title: 'shop alpha',
      entityRef: 'component:default/shop',
    });
    const archived = await p.sessions.create({
      ...NEW_SESSION,
      title: 'shop beta',
      entityRef: 'component:default/shop',
    });
    await p.sessions.update(archived.id, { archived: true });
    await p.sessions.create({
      ...NEW_SESSION,
      entityRef: 'component:default/other',
    });
    await p.sessions.create(NEW_SESSION);
    await p.sessions.create({
      ...NEW_SESSION,
      ownerRef: 'user:default/mallory',
      entityRef: 'component:default/shop',
    });

    const ids = async (opts: Parameters<typeof p.sessions.listByOwner>[1]) =>
      (await p.sessions.listByOwner('user:default/jane', opts)).map(s => s.id);
    expect(await ids({ entityRef: 'component:default/shop' })).toEqual([
      shop.id,
    ]);
    expect(
      (
        await ids({
          entityRef: 'component:default/shop',
          includeArchived: true,
        })
      ).sort(),
    ).toEqual([shop.id, archived.id].sort());
    expect(
      await ids({
        entityRef: 'component:default/shop',
        includeArchived: true,
        query: 'beta',
      }),
    ).toEqual([archived.id]);
    expect(await ids({ entityRef: 'component:default/none' })).toEqual([]);
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

  describe('purgeExpired (SE-05)', () => {
    const age = (id: string, updatedAt: string) =>
      p.knex('sessions').where({ id }).update({ updated_at: updatedAt });

    it('deletes a session last changed before the cutoff and keeps one changed at the cutoff', async () => {
      const cutoff = new Date('2026-04-01T00:00:00.000Z');
      const before = await p.sessions.create(NEW_SESSION);
      const at = await p.sessions.create(NEW_SESSION);
      const after = await p.sessions.create(NEW_SESSION);
      await age(before.id, '2026-03-31T23:59:59.999Z');
      await age(at.id, '2026-04-01T00:00:00.000Z');
      await age(after.id, '2026-04-01T00:00:00.001Z');

      expect(await p.sessions.purgeExpired(cutoff)).toBe(1);
      await expect(p.sessions.get(before.id)).rejects.toBeInstanceOf(
        SessionNotFound,
      );
      await expect(p.sessions.get(at.id)).resolves.toBeDefined();
      await expect(p.sessions.get(after.id)).resolves.toBeDefined();
    });

    it('keeps a session while its run has not ended, and deletes it once the run has ended', async () => {
      const running = await p.sessions.create(NEW_SESSION);
      await p.runs.start(running.id);
      await age(running.id, '2020-01-01T00:00:00.000Z');

      const waiting = await p.sessions.create(NEW_SESSION);
      const waitingRun = await p.runs.start(waiting.id);
      await p.runs.transition(waitingRun.id, 'waiting_approval', {
        leaseOwner: waitingRun.fence.leaseOwner,
      });
      await age(waiting.id, '2020-01-01T00:00:00.000Z');

      const ended = await p.sessions.create(NEW_SESSION);
      const endedRun = await p.runs.start(ended.id);
      await p.runs.transition(endedRun.id, 'completed', {
        leaseOwner: endedRun.fence.leaseOwner,
      });
      await age(ended.id, '2020-01-01T00:00:00.000Z');

      expect(await p.sessions.purgeExpired(p.clock.now())).toBe(1);
      await expect(p.sessions.get(running.id)).resolves.toBeDefined();
      await expect(p.sessions.get(waiting.id)).resolves.toBeDefined();
      await expect(p.sessions.get(ended.id)).rejects.toBeInstanceOf(
        SessionNotFound,
      );
    });

    it('deletes a pinned or archived session past the cutoff, and keeps one pinned more recently than the cutoff', async () => {
      const pinnedOld = await p.sessions.create(NEW_SESSION);
      await p.sessions.update(pinnedOld.id, { pinned: true });
      await age(pinnedOld.id, '2020-01-01T00:00:00.000Z');

      const archivedOld = await p.sessions.create(NEW_SESSION);
      await p.sessions.update(archivedOld.id, { archived: true });
      await age(archivedOld.id, '2020-01-01T00:00:00.000Z');

      const pinnedFresh = await p.sessions.create(NEW_SESSION);
      await p.sessions.update(pinnedFresh.id, { pinned: true });

      expect(await p.sessions.purgeExpired(p.clock.now())).toBe(2);
      await expect(p.sessions.get(pinnedOld.id)).rejects.toBeInstanceOf(
        SessionNotFound,
      );
      await expect(p.sessions.get(archivedOld.id)).rejects.toBeInstanceOf(
        SessionNotFound,
      );
      await expect(p.sessions.get(pinnedFresh.id)).resolves.toMatchObject({
        pinned: true,
      });
    });

    it('deletes the runs, items, queued messages and images with the session, and leaves a newer session', async () => {
      const session = await p.sessions.create(NEW_SESSION);
      const run = await p.runs.start(session.id);
      await p.items.append(
        session.id,
        [{ kind: 'user_message', text: 'hi' }],
        run.fence,
      );
      await p.queue.add(session.id, { text: 'later' }, { max: 5 });
      const image = await p.attachments.put({
        sessionId: session.id,
        ownerRef: NEW_SESSION.ownerRef,
        mediaType: 'image/png',
        name: 'a.png',
        bytes: IMAGES['image/png'],
        maxPending: 12,
      });
      await p.runs.transition(run.id, 'completed', {
        leaseOwner: run.fence.leaseOwner,
      });
      await age(session.id, '2020-01-01T00:00:00.000Z');
      const fresh = await p.sessions.create(NEW_SESSION);

      expect(await p.sessions.purgeExpired(p.clock.now())).toBe(1);
      expect(await p.knex('runs').where({ session_id: session.id })).toEqual(
        [],
      );
      expect(await p.knex('items').where({ session_id: session.id })).toEqual(
        [],
      );
      expect(
        await p.knex('queued_messages').where({ session_id: session.id }),
      ).toEqual([]);
      expect(await p.knex('attachments').where({ id: image.id })).toEqual([]);
      await expect(p.sessions.get(fresh.id)).resolves.toBeDefined();
    });
  });
});

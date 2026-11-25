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
  InsertLimitReached,
  NoActiveRun,
  QueueChanged,
  QueuedMessageNotFound,
  QueueFull,
  RunAlreadyActive,
  RunNotRunning,
} from '../../domain';
import {
  CONSTRAINT_ERROR,
  NEW_SESSION,
  createPersistence,
  databaseErrorOf,
} from './__testUtils__';

describe('KnexQueuedMessageRepository', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;
  let sessionId: string;
  let runId: string;

  beforeEach(async () => {
    p = await createPersistence();
    sessionId = (await p.sessions.create(NEW_SESSION)).id;
    const run = await p.runs.start(sessionId);
    runId = run.id;
    await p.items.append(
      sessionId,
      [{ kind: 'user_message', text: 'go' }],
      run.fence,
    );
  });

  afterEach(async () => {
    await p.cleanup();
  });

  const add = (text: string, max = 5, page?: { path: string }) =>
    p.queue.add(sessionId, { text, ...(page && { page }) }, { max });
  const texts = async () => (await p.queue.list(sessionId)).map(m => m.text);

  describe('add (IN-13)', () => {
    it('puts the messages at the end, with the positions 1, 2, 3', async () => {
      const a = await add('a');
      await add('b', 5, { path: '/catalog' });
      await add('c');
      expect(a).toMatchObject({ sessionId, position: 1, text: 'a' });
      expect(await p.queue.list(sessionId)).toMatchObject([
        { position: 1, text: 'a' },
        { position: 2, text: 'b', page: { path: '/catalog' } },
        { position: 3, text: 'c' },
      ]);
    });

    it('is refused without a run that has not ended, whatever the queue holds (NoActiveRun)', async () => {
      await p.runs.transition(runId, 'completed');
      await expect(add('late')).rejects.toBeInstanceOf(NoActiveRun);
      expect(await texts()).toEqual([]);
    });

    it('is allowed while the run waits for an approval', async () => {
      await p.runs.transition(runId, 'waiting_approval');
      await add('a');
      expect(await texts()).toEqual(['a']);
    });

    it('is refused when the queue has the most messages (QueueFull), and the sixth is the first one over five', async () => {
      for (let i = 1; i <= 5; i++) await add(`m${i}`);
      await expect(add('m6')).rejects.toBeInstanceOf(QueueFull);
      expect(await texts()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    });

    it('takes the position after the last one when a message in the middle is gone', async () => {
      const a = await add('a');
      await add('b');
      await p.queue.remove(sessionId, a.id);
      const c = await add('c');
      expect(c.position).toBe(3);
      expect(await texts()).toEqual(['b', 'c']);
    });

    it('lets in only the free places when several arrive at the same time', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_v, i) => add(`m${i}`)),
      );
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5);
      const positions = (await p.queue.list(sessionId)).map(m => m.position);
      expect(positions).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('update and remove', () => {
    it('changes the text and the page, and leaves the position', async () => {
      const a = await add('a', 5, { path: '/x' });
      p.clock.advance(10);
      const changed = await p.queue.update(sessionId, a.id, { text: 'a2' });
      expect(changed).toMatchObject({
        id: a.id,
        position: 1,
        text: 'a2',
        page: { path: '/x' },
        updatedAt: '2026-01-01T00:00:10.000Z',
      });
      const cleared = await p.queue.update(sessionId, a.id, { page: null });
      expect(cleared.page).toBeUndefined();
      expect(cleared.text).toBe('a2');
    });

    it('answers QueuedMessageNotFound for a message that is gone, or is of another session', async () => {
      const a = await add('a');
      const other = (await p.sessions.create(NEW_SESSION)).id;
      await expect(
        p.queue.update(other, a.id, { text: 'x' }),
      ).rejects.toBeInstanceOf(QueuedMessageNotFound);
      await expect(p.queue.remove(other, a.id)).rejects.toBeInstanceOf(
        QueuedMessageNotFound,
      );
      await p.queue.remove(sessionId, a.id);
      await expect(
        p.queue.update(sessionId, a.id, { text: 'x' }),
      ).rejects.toBeInstanceOf(QueuedMessageNotFound);
      await expect(p.queue.remove(sessionId, a.id)).rejects.toBeInstanceOf(
        QueuedMessageNotFound,
      );
    });
  });

  describe('reorder', () => {
    it('sets the order and the positions 1, 2, 3', async () => {
      const a = await add('a');
      const b = await add('b');
      const c = await add('c');
      const ordered = await p.queue.reorder(sessionId, [c.id, a.id, b.id]);
      expect(ordered).toMatchObject([
        { text: 'c', position: 1 },
        { text: 'a', position: 2 },
        { text: 'b', position: 3 },
      ]);
      expect(await texts()).toEqual(['c', 'a', 'b']);
    });

    it('refuses a list that another tab made out of date: a message was deleted, added or repeated (QueueChanged)', async () => {
      const a = await add('a');
      const b = await add('b');
      const c = await add('c');
      // Tab A deletes one; tab B still has the three ids.
      await p.queue.remove(sessionId, b.id);
      await expect(
        p.queue.reorder(sessionId, [c.id, b.id, a.id]),
      ).rejects.toBeInstanceOf(QueueChanged);
      // Tab B knows two and a third was added meanwhile.
      await add('d');
      await expect(
        p.queue.reorder(sessionId, [c.id, a.id]),
      ).rejects.toBeInstanceOf(QueueChanged);
      await expect(
        p.queue.reorder(sessionId, [c.id, c.id, a.id]),
      ).rejects.toBeInstanceOf(QueueChanged);
      // Nothing changed.
      expect(await texts()).toEqual(['a', 'c', 'd']);
      // A delete leaves a gap; only a reorder numbers the queue again.
      expect((await p.queue.list(sessionId)).map(m => m.position)).toEqual([
        1, 3, 4,
      ]);
      const [x, y, z] = await p.queue.list(sessionId);
      await p.queue.reorder(sessionId, [z.id, y.id, x.id]);
      expect((await p.queue.list(sessionId)).map(m => m.position)).toEqual([
        1, 2, 3,
      ]);
    });
  });

  describe('startNext (IN-14)', () => {
    beforeEach(async () => {
      await p.runs.transition(runId, 'completed');
    });

    it('starts a run with the first message: it leaves the queue and is the first item of the new run, with its page', async () => {
      const first = await p.runs.start(sessionId);
      await p.queue.add(
        sessionId,
        {
          text: 'first',
          page: { path: '/docs', entityRef: 'component:default/a' },
        },
        { max: 5 },
      );
      await p.queue.add(sessionId, { text: 'second' }, { max: 5 });
      await p.runs.transition(first.id, 'completed');

      const started = await p.queue.startNext(sessionId);

      expect(started!.run).toMatchObject({
        sessionId,
        status: 'running',
        fence: { runId: started!.run.id },
      });
      expect(started!.message).toMatchObject({ text: 'first' });
      expect(await texts()).toEqual(['second']);
      const log = await p.items.read(sessionId);
      const last = log[log.length - 1];
      expect(last).toMatchObject({
        kind: 'user_message',
        text: 'first',
        delivery: 'queued',
        runId: started!.run.id,
        page: { path: '/docs', entityRef: 'component:default/a' },
      });
      expect((await p.runs.findActive(sessionId))!.id).toBe(started!.run.id);
    });

    it('does nothing when the queue is empty: no run is left behind', async () => {
      expect(await p.queue.startNext(sessionId)).toBeUndefined();
      expect(await p.runs.findActive(sessionId)).toBeUndefined();
      expect(
        await p.knex('runs').where({ session_id: sessionId }),
      ).toHaveLength(1);
    });

    it('does nothing when the session has a run that has not ended already, and keeps the queue', async () => {
      const live = await p.runs.start(sessionId);
      await p.queue.add(sessionId, { text: 'a' }, { max: 5 });
      expect(await p.queue.startNext(sessionId)).toBeUndefined();
      expect((await p.runs.findActive(sessionId))!.id).toBe(live.id);
      expect(await texts()).toEqual(['a']);
    });

    it('sends the message once when several callers start at the same time: one run, one user_message, one row less', async () => {
      const first = await p.runs.start(sessionId);
      await p.queue.add(sessionId, { text: 'a' }, { max: 5 });
      await p.queue.add(sessionId, { text: 'b' }, { max: 5 });
      await p.runs.transition(first.id, 'completed');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => p.queue.startNext(sessionId)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await texts()).toEqual(['b']);
      const queued = (await p.items.read(sessionId)).filter(
        item => item.kind === 'user_message' && item.delivery === 'queued',
      );
      expect(queued).toHaveLength(1);
      expect(
        await p.knex('runs').whereNotNull('active_session_id'),
      ).toHaveLength(1);
    });

    it('puts everything back when the message cannot be written: no run, and the message stays in the queue in its place', async () => {
      const first = await p.runs.start(sessionId);
      await p.queue.add(sessionId, { text: 'a' }, { max: 5 });
      await p.queue.add(sessionId, { text: 'b' }, { max: 5 });
      await p.runs.transition(first.id, 'completed');
      const runsBefore = await p.knex('runs').select('id');
      // A number that is taken already makes the insert of the item fail.
      await p.knex('sessions').where({ id: sessionId }).update({ next_seq: 1 });

      await expect(
        databaseErrorOf(p.queue.startNext(sessionId)),
      ).resolves.toMatch(CONSTRAINT_ERROR);

      expect(await p.knex('runs').select('id')).toEqual(runsBefore);
      expect(await p.runs.findActive(sessionId)).toBeUndefined();
      expect(await texts()).toEqual(['a', 'b']);
      expect(
        await p.knex('sessions').where({ id: sessionId }).first('next_seq'),
      ).toEqual({ next_seq: 1 });
    });

    it('gives a new run its own lease and fence', async () => {
      const first = await p.runs.start(sessionId);
      await p.queue.add(sessionId, { text: 'a' }, { max: 5 });
      await p.runs.transition(first.id, 'completed');
      const started = await p.queue.startNext(sessionId);
      expect(started!.run.leaseExpiresAt).toBe('2026-01-01T00:00:30.000Z');
      expect(started!.run.fence.leaseOwner).toBe(started!.run.leaseOwner);
      await expect(p.runs.start(sessionId)).rejects.toBeInstanceOf(
        RunAlreadyActive,
      );
    });
  });

  describe('insert (IN-20)', () => {
    it('removes only that row, writes user_message with delivery inserted, and preserves remaining queue order', async () => {
      const first = await p.queue.add(sessionId, { text: 'one' }, { max: 5 });
      const middle = await p.queue.add(
        sessionId,
        {
          text: 'two',
          page: { path: '/catalog', entityRef: 'component:default/api' },
        },
        { max: 5 },
      );
      const last = await p.queue.add(sessionId, { text: 'three' }, { max: 5 });

      const item = await p.queue.insert(sessionId, middle.id, runId);

      expect(item).toMatchObject({
        kind: 'user_message',
        runId,
        text: 'two',
        delivery: 'inserted',
        page: { path: '/catalog', entityRef: 'component:default/api' },
      });
      const remaining = await p.queue.list(sessionId);
      expect(remaining.map(m => [m.id, m.position, m.text])).toEqual([
        [first.id, 1, 'one'],
        [last.id, 3, 'three'],
      ]);
      const log = await p.items.read(sessionId);
      expect(log[log.length - 1]).toEqual(item);
      expect((await p.runs.findActive(sessionId))?.id).toBe(runId);
    });

    it('throws RunNotRunning when run is ended, waiting_approval, expired, or from another session, leaving queue unchanged', async () => {
      const queued = await p.queue.add(sessionId, { text: 'hold' }, { max: 5 });
      const otherSession = (await p.sessions.create(NEW_SESSION)).id;
      const otherRun = await p.runs.start(otherSession);

      await expect(
        p.queue.insert(sessionId, queued.id, otherRun.id),
      ).rejects.toBeInstanceOf(RunNotRunning);
      await expect(
        p.queue.insert(sessionId, queued.id, 'missing-run'),
      ).rejects.toBeInstanceOf(RunNotRunning);

      await p.runs.transition(runId, 'waiting_approval');
      await expect(
        p.queue.insert(sessionId, queued.id, runId),
      ).rejects.toBeInstanceOf(RunNotRunning);

      await p.runs.acquireLease(runId);
      p.clock.advance(60);
      await expect(
        p.queue.insert(sessionId, queued.id, runId),
      ).rejects.toBeInstanceOf(RunNotRunning);

      await p.runs.transition(runId, 'completed');
      await expect(
        p.queue.insert(sessionId, queued.id, runId),
      ).rejects.toBeInstanceOf(RunNotRunning);

      expect(await texts()).toEqual(['hold']);
    });

    it('throws QueuedMessageNotFound when missing or removed, and InsertLimitReached after 5 inserts', async () => {
      await expect(
        p.queue.insert(sessionId, 'no-such-queued', runId),
      ).rejects.toBeInstanceOf(QueuedMessageNotFound);

      for (let i = 1; i <= 5; i++) {
        const q = await p.queue.add(sessionId, { text: `m${i}` }, { max: 10 });
        await p.queue.insert(sessionId, q.id, runId, { maxInsertsPerRun: 5 });
      }
      const sixth = await p.queue.add(sessionId, { text: 'm6' }, { max: 10 });
      await expect(
        p.queue.insert(sessionId, sixth.id, runId, { maxInsertsPerRun: 5 }),
      ).rejects.toBeInstanceOf(InsertLimitReached);
      expect(await texts()).toEqual(['m6']);
    });

    it('only one wins when racing insert with startNext on SQLite', async () => {
      const q = await p.queue.add(sessionId, { text: 'race' }, { max: 5 });
      await p.runs.transition(runId, 'completed');
      const [inserted, started] = await Promise.allSettled([
        p.queue.insert(sessionId, q.id, runId),
        p.queue.startNext(sessionId),
      ]);
      expect(inserted.status).toBe('rejected');
      expect((inserted as PromiseRejectedResult).reason).toBeInstanceOf(
        RunNotRunning,
      );
      expect(started.status).toBe('fulfilled');
      expect((started as PromiseFulfilledResult<any>).value).toBeDefined();
      const raceItems = (await p.items.read(sessionId)).filter(
        i => i.kind === 'user_message' && i.text === 'race',
      );
      expect(raceItems).toHaveLength(1);
    });
  });
});

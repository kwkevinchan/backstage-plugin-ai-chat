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
  DuplicateItem,
  LeaseLost,
  type ItemBody,
} from '@kwkevinchan/ai-chat-harness';
import { itemLogContract } from '@kwkevinchan/ai-chat-harness/testing';
import {
  CONSTRAINT_ERROR,
  NEW_SESSION,
  createPersistence,
  databaseErrorOf,
} from './__testUtils__';

itemLogContract('KnexItemLog', async () => {
  const p = await createPersistence();
  return {
    cleanup: p.cleanup,
    subject: {
      log: p.items,
      newSession: async () => {
        const session = await p.sessions.create(NEW_SESSION);
        const { fence } = await p.runs.start(session.id);
        return {
          sessionId: session.id,
          fence,
          staleFence: { runId: fence.runId, leaseOwner: 'backend-b' },
        };
      },
    },
  };
});

const user = (text: string): ItemBody => ({ kind: 'user_message', text });
const agent = (text: string): ItemBody => ({ kind: 'agent_message', text });
const approval = (
  callId: string,
  decision: 'allow' | 'deny' = 'allow',
): ItemBody => ({
  kind: 'approval',
  callId,
  decision,
  decidedBy: 'user:default/jane',
});

describe('KnexItemLog', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;

  beforeEach(async () => {
    p = await createPersistence();
  });

  afterEach(async () => {
    await p.cleanup();
  });

  async function start() {
    const session = await p.sessions.create(NEW_SESSION);
    const run = await p.runs.start(session.id);
    return { sessionId: session.id, run, fence: run.fence };
  }

  it('refuses a second approval for the same call, and keeps the first decision (T-07)', async () => {
    const { sessionId, fence } = await start();
    await p.items.append(sessionId, [approval('call-1', 'allow')], fence);
    await expect(
      p.items.append(sessionId, [approval('call-1', 'deny')], fence),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_ITEM',
      dedupeKey: 'approval:call-1',
    });
    const items = await p.items.read(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'approval', decision: 'allow' });
  });

  it('refuses two approvals for one call that are written at the same time, and writes one (T-07)', async () => {
    const { sessionId, fence } = await start();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_v, i) =>
        p.items.append(
          sessionId,
          [approval('call-1', i % 2 ? 'allow' : 'deny')],
          fence,
        ),
      ),
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const reasons = results.flatMap(r =>
      r.status === 'rejected' ? [r.reason] : [],
    );
    expect(reasons).toHaveLength(5);
    expect(reasons.every(reason => reason instanceof DuplicateItem)).toBe(true);
    expect(await p.items.read(sessionId)).toHaveLength(1);
  });

  it('is guarded by the unique index too, not only by the check of the log', async () => {
    const { sessionId, fence } = await start();
    await p.items.append(sessionId, [approval('call-1')], fence);
    const insert = p.knex('items').insert({
      session_id: sessionId,
      seq: 99,
      run_id: fence.runId,
      kind: 'approval',
      payload: '{}',
      dedupe_key: 'approval:call-1',
      created_at: new Date().toISOString(),
    });
    await expect(databaseErrorOf(insert)).resolves.toMatch(CONSTRAINT_ERROR);
  });

  it('numbers many appends at the same time without a repeat or a gap', async () => {
    const { sessionId, fence } = await start();
    const written = await Promise.all(
      Array.from({ length: 12 }, (_v, i) =>
        p.items.append(sessionId, [agent(`a${i}`), agent(`b${i}`)], fence),
      ),
    );
    const seqs = written.flat().map(item => item.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_v, i) => i + 1),
    );
    for (const batch of written) {
      expect(batch[1].seq).toBe(batch[0].seq + 1);
    }
    const row = await p.knex('sessions').where({ id: sessionId }).first();
    expect(row.next_seq).toBe(25);
  });

  it('keeps the numbers free after a refused append: next_seq does not move', async () => {
    const { sessionId, fence } = await start();
    await p.items.append(sessionId, [agent('a')], fence);
    await expect(
      p.items.append(sessionId, [agent('b'), agent('c')], {
        ...fence,
        leaseOwner: 'backend-b',
      }),
    ).rejects.toBeInstanceOf(LeaseLost);
    const row = await p.knex('sessions').where({ id: sessionId }).first();
    expect(row.next_seq).toBe(2);
  });

  describe('lease', () => {
    it('refuses what the loop writes from a backend that took over the lease', async () => {
      const { sessionId, run, fence } = await start();
      p.clock.advance(31);
      const other = p.runsOf('backend-b');
      const taken = await other.acquireLease(run.id);
      expect(taken).toBeDefined();
      await expect(
        p.items.append(sessionId, [agent('late')], fence),
      ).rejects.toBeInstanceOf(LeaseLost);
      await expect(
        p.items.append(sessionId, [agent('now')], taken!.fence),
      ).resolves.toHaveLength(1);
    });

    it('refuses what the loop writes after the run has ended', async () => {
      const { sessionId, run, fence } = await start();
      await p.runs.transition(run.id, 'completed');
      await expect(
        p.items.append(sessionId, [agent('late')], fence),
      ).rejects.toBeInstanceOf(LeaseLost);
    });

    it('lets the host write a user message and an approval without the lease, while the run is active', async () => {
      const { sessionId, run, fence } = await start();
      await p.runs.transition(run.id, 'waiting_approval', {
        leaseOwner: fence.leaseOwner,
      });
      const hostFence = { runId: run.id, leaseOwner: 'backend-b' };
      await expect(
        p.items.append(sessionId, [approval('call-1')], hostFence),
      ).resolves.toHaveLength(1);
      await expect(
        p.items.append(sessionId, [agent('loop')], hostFence),
      ).rejects.toBeInstanceOf(LeaseLost);
      // A batch with one item of the loop needs the lease for all of it.
      await expect(
        p.items.append(sessionId, [user('x'), agent('y')], hostFence),
      ).rejects.toBeInstanceOf(LeaseLost);
    });

    it('refuses even the host messages once the run has ended', async () => {
      const { sessionId, run, fence } = await start();
      await p.runs.transition(run.id, 'cancelled');
      await expect(
        p.items.append(sessionId, [user('late')], fence),
      ).rejects.toBeInstanceOf(LeaseLost);
    });

    it('refuses a host message with the fence of a run of another session', async () => {
      const one = await start();
      const two = await start();
      await expect(
        p.items.append(two.sessionId, [user('a')], one.fence),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect(await p.items.read(two.sessionId)).toEqual([]);
    });

    it('refuses a run that does not exist', async () => {
      const { sessionId } = await start();
      await expect(
        p.items.append(sessionId, [agent('a')], {
          runId: 'nope',
          leaseOwner: 'backend-a',
        }),
      ).rejects.toBeInstanceOf(LeaseLost);
    });
  });

  it('removes the items with the session', async () => {
    const { sessionId, fence } = await start();
    await p.items.append(sessionId, [user('a')], fence);
    await p.sessions.delete(sessionId);
    expect(await p.items.read(sessionId)).toEqual([]);
    expect(await p.knex('runs').where({ session_id: sessionId })).toEqual([]);
  });

  it('changes updated_at of the session with each append', async () => {
    const { sessionId, fence } = await start();
    p.clock.advance(60);
    await p.items.append(sessionId, [user('a')], fence);
    const session = await p.sessions.get(sessionId);
    expect(session.updatedAt).toBe(p.clock.now().toISOString());
    expect(session.updatedAt).not.toBe(session.createdAt);
  });
});

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
import { KnexItemLog } from './KnexItemLog';
import { InsertLimitReached } from '../../domain';
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

const inserted = (text: string): ItemBody => ({
  kind: 'user_message',
  text,
  delivery: 'inserted',
});
/** The output of a model call that read the log up to `readUpToSeq`. */
const output = (readUpToSeq: number): ItemBody => ({
  kind: 'agent_message',
  text: 'answer',
  readUpToSeq,
});
/** What a caller that does not hold the lease writes with (the host). */
const asHost = (runId: string) => ({ runId, leaseOwner: '' });

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

  it('gives the numbers back when an append is refused after it took them: next_seq does not move', async () => {
    const { sessionId, fence } = await start();
    await p.items.append(sessionId, [approval('call-1')], fence);
    // The duplicate is found after next_seq was increased, in the same
    // transaction.
    await expect(
      p.items.append(
        sessionId,
        [agent('b'), agent('c'), approval('call-1')],
        fence,
      ),
    ).rejects.toBeInstanceOf(DuplicateItem);
    const row = await p.knex('sessions').where({ id: sessionId }).first();
    expect(row.next_seq).toBe(2);
    const [next] = await p.items.append(sessionId, [agent('d')], fence);
    expect(next.seq).toBe(2);
  });

  it('does not move next_seq for a write that the lease refuses', async () => {
    const { sessionId, fence } = await start();
    await p.items.append(sessionId, [agent('a')], fence);
    await expect(
      p.items.append(sessionId, [agent('b'), agent('c')], {
        ...fence,
        leaseOwner: 'not-the-owner',
      }),
    ).rejects.toBeInstanceOf(LeaseLost);
    const row = await p.knex('sessions').where({ id: sessionId }).first();
    expect(row.next_seq).toBe(2);
  });

  describe('lease', () => {
    it('refuses what the loop writes from a backend that took over the lease', async () => {
      const { sessionId, run, fence } = await start();
      p.clock.advance(31);
      const taken = await p.newRuns().acquireLease(run.id);
      expect(taken).toBeDefined();
      await expect(
        p.items.append(sessionId, [agent('late')], fence),
      ).rejects.toBeInstanceOf(LeaseLost);
      await expect(
        p.items.append(sessionId, [agent('now')], taken!.fence),
      ).resolves.toHaveLength(1);
    });

    it('refuses the old fence of the same backend after it took the run again', async () => {
      const { sessionId, run, fence } = await start();
      p.clock.advance(31);
      const again = await p.runs.acquireLease(run.id);
      await expect(
        p.items.append(sessionId, [agent('late')], fence),
      ).rejects.toBeInstanceOf(LeaseLost);
      await expect(
        p.items.append(sessionId, [agent('now')], again!.fence),
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

  describe('an inserted message (IN-10, IN-11)', () => {
    it('is written for a running run without its lease owner, and sets nothing else', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      const [item] = await p.items.append(
        sessionId,
        [inserted('also this')],
        asHost(run.id),
      );
      expect(item).toMatchObject({
        kind: 'user_message',
        seq: 2,
        runId: run.id,
        delivery: 'inserted',
      });
      expect((await p.runs.get(run.id)).status).toBe('running');
    });

    it.each([
      ['waits for an approval', 'waiting_approval'],
      ['has completed', 'completed'],
      ['was cancelled', 'cancelled'],
    ] as const)('is refused when the run %s', async (_name, status) => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      await p.runs.transition(run.id, status);
      await expect(
        p.items.append(sessionId, [inserted('late')], asHost(run.id)),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect(await p.items.read(sessionId)).toHaveLength(1);
    });

    it('is refused when the lease has expired, though nobody marked the run expired yet', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      p.clock.advance(31);
      await expect(
        p.items.append(sessionId, [inserted('late')], asHost(run.id)),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect(await p.items.read(sessionId)).toHaveLength(1);
      // The heartbeat of the owner makes the run live again.
      await p.runs.heartbeat(fence);
      await p.items.append(sessionId, [inserted('on time')], asHost(run.id));
      expect(await p.items.read(sessionId)).toHaveLength(2);
    });

    it('is refused for a run of another session', async () => {
      const one = await start();
      const two = await start();
      await expect(
        p.items.append(two.sessionId, [inserted('x')], asHost(one.run.id)),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect(await p.items.read(two.sessionId)).toEqual([]);
    });

    it('takes at most the number the log is set up for, counted from the second message of the run', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      for (let i = 1; i <= 5; i++) {
        await p.items.append(sessionId, [inserted(`m${i}`)], asHost(run.id));
      }
      await expect(
        p.items.append(sessionId, [inserted('m6')], asHost(run.id)),
      ).rejects.toBeInstanceOf(InsertLimitReached);
      // Nothing was written, and the number was given back.
      const log = await p.items.read(sessionId);
      expect(log).toHaveLength(6);
      const next = await p.items.append(sessionId, [agent('a')], fence);
      expect(next[0].seq).toBe(7);
    });

    it('counts the messages of this run only, and uses the limit of the setup', async () => {
      const small = new KnexItemLog(p.knex, p.clock, { maxInsertsPerRun: 1 });
      const { sessionId, run, fence } = await start();
      await small.append(sessionId, [user('go')], fence);
      await small.append(sessionId, [inserted('one')], asHost(run.id));
      await expect(
        small.append(sessionId, [inserted('two')], asHost(run.id)),
      ).rejects.toBeInstanceOf(InsertLimitReached);
      await p.runs.transition(run.id, 'completed');
      // A new run of the session starts with its own count.
      const next = await p.runs.start(sessionId);
      await small.append(sessionId, [user('again')], next.fence);
      await small.append(sessionId, [inserted('one')], asHost(next.id));
    });

    it('lets five of nine inserts that arrive at the same time through', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_v, i) =>
          p.items.append(sessionId, [inserted(`m${i}`)], asHost(run.id)),
        ),
      );
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5);
      const reasons = results.flatMap(r =>
        r.status === 'rejected' ? [r.reason] : [],
      );
      expect(reasons.every(r => r instanceof InsertLimitReached)).toBe(true);
      const seqs = (await p.items.read(sessionId)).map(item => item.seq);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('runs.read_up_to_seq', () => {
    const readUpToSeqOf = async (runId: string) =>
      (await p.knex('runs').where({ id: runId }).first('read_up_to_seq'))
        .read_up_to_seq;

    it('is the largest readUpToSeq of the model output that was written, and never goes down', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      expect(await readUpToSeqOf(run.id)).toBe(0);
      await p.items.append(sessionId, [output(1)], fence);
      expect(await readUpToSeqOf(run.id)).toBe(1);
      await p.items.append(sessionId, [inserted('x')], asHost(run.id));
      await p.items.append(sessionId, [output(3)], fence);
      expect(await readUpToSeqOf(run.id)).toBe(3);
      // A call that read less (a late one) does not take it back.
      await p.items.append(sessionId, [output(2)], fence);
      expect(await readUpToSeqOf(run.id)).toBe(3);
    });

    it('takes the largest value of a batch, and ignores the output of a tool call batch without a mark', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      await p.items.append(
        sessionId,
        [
          { kind: 'agent_message', text: 'a', readUpToSeq: 1 },
          {
            kind: 'tool_call',
            callId: 'c1',
            toolId: 'demo:read',
            input: {},
            schemaHash: 'h',
            policy: 'allow',
            readOnly: true,
            step: 1,
            position: 0,
            readUpToSeq: 4,
          },
        ],
        fence,
      );
      expect(await readUpToSeqOf(run.id)).toBe(4);
      await p.items.append(sessionId, [agent('P1 item without a mark')], fence);
      expect(await readUpToSeqOf(run.id)).toBe(4);
    });

    it('is not changed by what is not model output, nor by a write that fails', async () => {
      const { sessionId, run, fence } = await start();
      await p.items.append(sessionId, [user('go')], fence);
      await p.items.append(
        sessionId,
        [{ kind: 'summary', coversUpToSeq: 1, text: 's' }],
        fence,
      );
      expect(await readUpToSeqOf(run.id)).toBe(0);
      // An output that is refused (the lease is another one) leaves it alone.
      await expect(
        p.items.append(sessionId, [output(9)], {
          runId: run.id,
          leaseOwner: 'other',
        }),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect(await readUpToSeqOf(run.id)).toBe(0);
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

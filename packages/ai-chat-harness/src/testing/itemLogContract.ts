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

// The contract is a set of tests that other packages call from their own test
// files, so it exports a function that declares them.
/* eslint-disable jest/no-export */

import {
  DuplicateItem,
  LeaseLost,
  type ItemBody,
  type JsonObject,
  type ItemLog,
  type RunFence,
} from '@kwkevinchan/ai-chat-harness';

/**
 * A session the log can write to, with a fence of a run of that session.
 *
 * @public
 */
export type ItemLogSession = {
  sessionId: string;
  /** A fence whose owner holds the lease of its run. */
  fence: RunFence;
  /** A fence of the same run whose owner does not hold the lease. */
  staleFence: RunFence;
};

/**
 * What `itemLogContract` needs from an implementation under test.
 *
 * @public
 */
export type ItemLogSubject = {
  log: ItemLog;
  /**
   * Makes a session and a run in it. Each call gives a new session with its
   * own run, so a fence is good for its own session only.
   */
  newSession: () => Promise<ItemLogSession>;
};

/**
 * The tests every `ItemLog` passes (A-10): the in-memory one and the one of
 * the database. `create` is called for each test and gives a clean log.
 *
 * The lease tests write the kinds the loop writes with its fence. The host
 * writes `user_message` and `approval` too, and a database log may check the
 * status of the run for those instead of the lease, so no test here relies on
 * the lease for them.
 *
 * @public
 */
export function itemLogContract(
  name: string,
  create: () => Promise<{
    subject: ItemLogSubject;
    cleanup?: () => Promise<void>;
  }>,
): void {
  describe(`ItemLog contract: ${name}`, () => {
    let subject: ItemLogSubject;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      ({ subject, cleanup } = await create());
    });

    afterEach(async () => {
      await cleanup?.();
    });

    const user = (text: string): ItemBody => ({ kind: 'user_message', text });
    const agent = (text: string): ItemBody => ({ kind: 'agent_message', text });
    const toolCall = (callId: string, input: JsonObject = {}): ItemBody => ({
      kind: 'tool_call',
      callId,
      toolId: 'catalog:get-entity',
      input,
      schemaHash: 'hash',
      policy: 'allow',
      readOnly: true,
      step: 1,
      position: 0,
    });
    const approval = (callId: string): ItemBody => ({
      kind: 'approval',
      callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });
    const started = (callId: string): ItemBody => ({
      kind: 'tool_started',
      callId,
    });
    const result = (callId: string): ItemBody => ({
      kind: 'tool_result',
      callId,
      status: 'ok',
    });

    it('reads nothing from a session with no items', async () => {
      const { sessionId } = await subject.newSession();
      expect(await subject.log.read(sessionId)).toEqual([]);
    });

    it('numbers the items from 1, one after the other, over several appends', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      const first = await log.append(sessionId, [user('a')], fence);
      const second = await log.append(sessionId, [user('b')], fence);
      const third = await log.append(sessionId, [user('c')], fence);
      expect([first[0].seq, second[0].seq, third[0].seq]).toEqual([1, 2, 3]);
      const all = await log.read(sessionId);
      expect(all.map(item => item.seq)).toEqual([1, 2, 3]);
    });

    it('gives the items of one append consecutive numbers, in the order given', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      await log.append(sessionId, [user('first')], fence);
      const written = await log.append(
        sessionId,
        [agent('text'), toolCall('call-1'), toolCall('call-2')],
        fence,
      );
      expect(written.map(item => item.seq)).toEqual([2, 3, 4]);
      expect(written.map(item => item.kind)).toEqual([
        'agent_message',
        'tool_call',
        'tool_call',
      ]);
      expect(await log.read(sessionId)).toEqual([
        expect.objectContaining({ seq: 1 }),
        ...written,
      ]);
    });

    it('keeps the session id, the run id of the fence and the time on every item', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      const [item] = await log.append(sessionId, [user('a')], fence);
      expect(item).toMatchObject({
        kind: 'user_message',
        text: 'a',
        sessionId,
        runId: fence.runId,
      });
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
    });

    it('keeps the sessions apart', async () => {
      const { log, newSession } = subject;
      const one = await newSession();
      const two = await newSession();
      await log.append(one.sessionId, [user('a'), user('b')], one.fence);
      const [item] = await log.append(two.sessionId, [user('c')], two.fence);
      expect(item.seq).toBe(1);
      expect(await log.read(one.sessionId)).toHaveLength(2);
    });

    it('reads only the items after afterSeq', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      await log.append(sessionId, [user('a'), user('b'), user('c')], fence);
      const after = await log.read(sessionId, { afterSeq: 1 });
      expect(after.map(item => item.seq)).toEqual([2, 3]);
      expect(await log.read(sessionId, { afterSeq: 3 })).toEqual([]);
      expect(await log.read(sessionId, { afterSeq: 0 })).toHaveLength(3);
    });

    it('reads from the newest summary on with fromLatestSummary', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      const summary = (coversUpToSeq: number): ItemBody => ({
        kind: 'summary',
        coversUpToSeq,
        text: `up to ${coversUpToSeq}`,
      });
      await log.append(sessionId, [user('a'), user('b')], fence);
      // No summary: every item.
      expect(
        await log.read(sessionId, { fromLatestSummary: true }),
      ).toHaveLength(2);

      await log.append(
        sessionId,
        [user('c'), user('d'), summary(2), user('e')],
        fence,
      );
      const first = await log.read(sessionId, { fromLatestSummary: true });
      expect(first.map(item => item.seq)).toEqual([3, 4, 5, 6]);

      await log.append(sessionId, [summary(4), user('f')], fence);
      const second = await log.read(sessionId, { fromLatestSummary: true });
      expect(second.map(item => item.seq)).toEqual([5, 6, 7, 8]);

      // With both options the larger bound counts.
      const both = await log.read(sessionId, {
        fromLatestSummary: true,
        afterSeq: 6,
      });
      expect(both.map(item => item.seq)).toEqual([7, 8]);
      expect(await log.read(sessionId)).toHaveLength(8);
    });

    it('reads everything with fromLatestSummary when the newest summary has no usable coversUpToSeq', async () => {
      const { log, newSession } = subject;
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const { sessionId, fence } = await newSession();
        await log.append(
          sessionId,
          [
            user('a'),
            user('b'),
            { kind: 'summary', coversUpToSeq: bad, text: 'broken' },
            user('c'),
          ],
          fence,
        );
        const read = await log.read(sessionId, { fromLatestSummary: true });
        expect(read.map(item => item.seq)).toEqual([1, 2, 3, 4]);
      }
    });

    describe('latestPlanUpdate', () => {
      const plan = (text: string): ItemBody => ({
        kind: 'plan_update',
        plan: { items: [{ text, status: 'pending' }] },
      });

      it('is undefined for a session with no plan_update', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        expect(await log.latestPlanUpdate(sessionId)).toBeUndefined();
        await log.append(sessionId, [user('a'), agent('b')], fence);
        expect(await log.latestPlanUpdate(sessionId)).toBeUndefined();
      });

      it('is the last plan_update of the session, with its seq', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        const other = await newSession();
        await log.append(
          sessionId,
          [user('a'), plan('first'), agent('b'), plan('second'), agent('c')],
          fence,
        );
        await log.append(other.sessionId, [plan('elsewhere')], other.fence);
        expect(await log.latestPlanUpdate(sessionId)).toMatchObject({
          kind: 'plan_update',
          seq: 4,
          sessionId,
          plan: { items: [{ text: 'second', status: 'pending' }] },
        });
      });

      it('reads a plan_update that the newest summary covers', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await log.append(
          sessionId,
          [
            user('a'),
            plan('covered'),
            agent('b'),
            user('c'),
            { kind: 'summary', coversUpToSeq: 3, text: 'so far' },
          ],
          fence,
        );
        const window = await log.read(sessionId, { fromLatestSummary: true });
        expect(window.some(item => item.kind === 'plan_update')).toBe(false);
        expect(await log.latestPlanUpdate(sessionId)).toMatchObject({
          seq: 2,
          plan: { items: [{ text: 'covered', status: 'pending' }] },
        });
      });
    });

    it('does not change what it read when the caller changes it', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      await log.append(sessionId, [user('a')], fence);
      const [item] = await log.read(sessionId);
      (item as { text: string }).text = 'changed';
      const [again] = await log.read(sessionId);
      expect(again).toMatchObject({ text: 'a' });
    });

    it('reads back every kind of item as it was written', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      const bodies: ItemBody[] = [
        user('question'),
        agent('answer'),
        toolCall('call-1', {
          list: [1, 'two', null, { deep: true }],
          nested: { a: {} },
        }),
        approval('call-1'),
        started('call-1'),
        {
          kind: 'tool_result',
          callId: 'call-1',
          status: 'ok',
          output: {
            items: [{ name: 'a', tags: ['x', 'y'] }, null, 3],
            nothing: null,
            nested: { deeper: { flag: false } },
          },
          truncated: true,
          message: 'cut',
        },
        {
          kind: 'plan_update',
          plan: {
            items: [
              { text: 'one', status: 'completed' },
              { text: 'two', status: 'in_progress' },
            ],
          },
        },
        { kind: 'summary', coversUpToSeq: 3, text: 'so far' },
        { kind: 'note', text: 'a remark' },
      ];
      expect(new Set(bodies.map(body => body.kind)).size).toBe(9);
      await log.append(sessionId, bodies, fence);
      const read = await log.read(sessionId);
      expect(read).toHaveLength(9);
      read.forEach((item, index) => {
        expect(item).toMatchObject(bodies[index] as object);
        expect(item.seq).toBe(index + 1);
      });
      expect((read[5] as { output: unknown }).output).toEqual(
        (bodies[5] as { output: unknown }).output,
      );
    });

    it('numbers two appends to one session at the same time without a repeat or a gap', async () => {
      const { log, newSession } = subject;
      const { sessionId, fence } = await newSession();
      const [one, two] = await Promise.all([
        log.append(sessionId, [agent('a'), agent('b'), agent('c')], fence),
        log.append(sessionId, [agent('d'), agent('e')], fence),
      ]);
      const seqs = [...one, ...two].map(item => item.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
      // Each append got a run of numbers.
      expect(one.map(i => i.seq)).toEqual(
        Array.from({ length: one.length }, (_v, i) => one[0].seq + i),
      );
      expect(two.map(i => i.seq)).toEqual(
        Array.from({ length: two.length }, (_v, i) => two[0].seq + i),
      );
      expect((await log.read(sessionId)).map(item => item.seq)).toEqual([
        1, 2, 3, 4, 5,
      ]);
    });

    describe('the fields of an inserted message and of the marks of the model output', () => {
      it('stores and reads back delivery and readUpToSeq as they were written', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        const written = await log.append(
          sessionId,
          [
            { kind: 'user_message', text: 'first', delivery: 'direct' },
            { kind: 'user_message', text: 'inserted', delivery: 'inserted' },
            { kind: 'user_message', text: 'queued', delivery: 'queued' },
            { kind: 'agent_message', text: 'answer', readUpToSeq: 7 },
            { ...(toolCall('call-1') as object), readUpToSeq: 7 } as ItemBody,
          ],
          fence,
        );
        const read = await log.read(sessionId);
        expect(read).toEqual(written);
        expect(
          read.map(item => (item as { delivery?: string }).delivery),
        ).toEqual(['direct', 'inserted', 'queued', undefined, undefined]);
        expect(
          read.map(item => (item as { readUpToSeq?: number }).readUpToSeq),
        ).toEqual([undefined, undefined, undefined, 7, 7]);
      });

      it('keeps a readUpToSeq of 0', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await log.append(
          sessionId,
          [{ kind: 'agent_message', text: 'answer', readUpToSeq: 0 }],
          fence,
        );
        expect((await log.read(sessionId))[0]).toMatchObject({
          readUpToSeq: 0,
        });
      });

      it('does not add the fields to an item written without them', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await log.append(
          sessionId,
          [user('plain'), agent('plain'), toolCall('call-1')],
          fence,
        );
        for (const item of await log.read(sessionId)) {
          expect(item).not.toHaveProperty('delivery');
          expect(item).not.toHaveProperty('readUpToSeq');
        }
      });
    });

    describe('dedupe', () => {
      it.each<[string, (callId: string) => ItemBody]>([
        ['tool_call', toolCall],
        ['approval', approval],
        ['tool_started', started],
        ['tool_result', result],
      ])('refuses a second %s for the same call', async (_kind, make) => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await log.append(sessionId, [make('call-1')], fence);
        await expect(
          log.append(sessionId, [make('call-1')], fence),
        ).rejects.toBeInstanceOf(DuplicateItem);
      });

      it('writes none of the items of an append that has a duplicate', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await log.append(sessionId, [toolCall('call-1')], fence);
        await expect(
          log.append(
            sessionId,
            [agent('new'), toolCall('call-2'), toolCall('call-1')],
            fence,
          ),
        ).rejects.toMatchObject({ dedupeKey: 'tool_call:call-1' });
        expect(await log.read(sessionId)).toHaveLength(1);
        // The sequence has no gap after the refused append.
        const [next] = await log.append(sessionId, [toolCall('call-2')], fence);
        expect(next.seq).toBe(2);
      });

      it('refuses a duplicate inside one append', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await expect(
          log.append(
            sessionId,
            [toolCall('call-1'), toolCall('call-1')],
            fence,
          ),
        ).rejects.toBeInstanceOf(DuplicateItem);
        expect(await log.read(sessionId)).toEqual([]);
      });

      it('allows the different kinds of one call, and the same id in another session', async () => {
        const { log, newSession } = subject;
        const one = await newSession();
        const two = await newSession();
        await log.append(
          one.sessionId,
          [toolCall('call-1'), approval('call-1'), started('call-1')],
          one.fence,
        );
        await log.append(one.sessionId, [result('call-1')], one.fence);
        await log.append(two.sessionId, [toolCall('call-1')], two.fence);
        expect(await log.read(one.sessionId)).toHaveLength(4);
        expect(await log.read(two.sessionId)).toHaveLength(1);
      });

      it('allows the items that have no key as often as needed', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence } = await newSession();
        await log.append(sessionId, [agent('same'), agent('same')], fence);
        await log.append(sessionId, [agent('same')], fence);
        expect(await log.read(sessionId)).toHaveLength(3);
      });
    });

    describe('lease', () => {
      it.each<[string, ItemBody]>([
        ['agent_message', agent('a')],
        ['tool_call', toolCall('call-1')],
        ['tool_result', result('call-1')],
      ])(
        'refuses a %s from an owner that does not hold the lease',
        async (_kind, body) => {
          const { log, newSession } = subject;
          const { sessionId, staleFence } = await newSession();
          await expect(
            log.append(sessionId, [body], staleFence),
          ).rejects.toBeInstanceOf(LeaseLost);
          await expect(
            log.append(sessionId, [body], staleFence),
          ).rejects.toMatchObject({ runId: staleFence.runId });
        },
      );

      it('writes nothing for a refused write, and leaves no gap', async () => {
        const { log, newSession } = subject;
        const { sessionId, fence, staleFence } = await newSession();
        await log.append(sessionId, [agent('a')], fence);
        await expect(
          log.append(sessionId, [agent('b'), toolCall('call-1')], staleFence),
        ).rejects.toBeInstanceOf(LeaseLost);
        expect(await log.read(sessionId)).toHaveLength(1);
        const [next] = await log.append(sessionId, [agent('d')], fence);
        expect(next.seq).toBe(2);
      });

      it('refuses a fence of a run that belongs to another session', async () => {
        const { log, newSession } = subject;
        const one = await newSession();
        const two = await newSession();
        await expect(
          log.append(two.sessionId, [agent('a')], one.fence),
        ).rejects.toBeInstanceOf(LeaseLost);
        expect(await log.read(two.sessionId)).toEqual([]);
      });
    });
  });
}

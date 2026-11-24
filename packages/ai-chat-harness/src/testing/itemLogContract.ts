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
  type ItemLog,
  type RunFence,
} from '@kwkevinchan/ai-chat-harness';

/**
 * What `itemLogContract` needs from an implementation under test.
 *
 * @public
 */
export type ItemLogSubject = {
  log: ItemLog;
  /** A fence whose owner holds the lease of its run. */
  fence: RunFence;
  /** A fence of the same run whose owner does not hold the lease. */
  staleFence: RunFence;
  /** Makes a session the log can write to. Each call gives a new one. */
  newSession: () => Promise<string>;
};

/**
 * The tests every `ItemLog` passes (A-10): the in-memory one and the one of
 * the database. `create` is called for each test and gives a clean log.
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
    const toolCall = (callId: string): ItemBody => ({
      kind: 'tool_call',
      callId,
      toolId: 'catalog:get-entity',
      input: {},
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
      const sessionId = await subject.newSession();
      expect(await subject.log.read(sessionId)).toEqual([]);
    });

    it('numbers the items from 1, one after the other, over several appends', async () => {
      const { log, fence, newSession } = subject;
      const sessionId = await newSession();
      const first = await log.append(sessionId, [user('a')], fence);
      const second = await log.append(sessionId, [user('b')], fence);
      const third = await log.append(sessionId, [user('c')], fence);
      expect([first[0].seq, second[0].seq, third[0].seq]).toEqual([1, 2, 3]);
      const all = await log.read(sessionId);
      expect(all.map(item => item.seq)).toEqual([1, 2, 3]);
    });

    it('gives the items of one append consecutive numbers, in the order given', async () => {
      const { log, fence, newSession } = subject;
      const sessionId = await newSession();
      await log.append(sessionId, [user('first')], fence);
      const written = await log.append(
        sessionId,
        [
          { kind: 'agent_message', text: 'text' },
          toolCall('call-1'),
          toolCall('call-2'),
        ],
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
      const { log, fence, newSession } = subject;
      const sessionId = await newSession();
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
      const { log, fence, newSession } = subject;
      const one = await newSession();
      const two = await newSession();
      await log.append(one, [user('a'), user('b')], fence);
      const [item] = await log.append(two, [user('c')], fence);
      expect(item.seq).toBe(1);
      expect(await log.read(one)).toHaveLength(2);
    });

    it('reads only the items after afterSeq', async () => {
      const { log, fence, newSession } = subject;
      const sessionId = await newSession();
      await log.append(sessionId, [user('a'), user('b'), user('c')], fence);
      const after = await log.read(sessionId, { afterSeq: 1 });
      expect(after.map(item => item.seq)).toEqual([2, 3]);
      expect(await log.read(sessionId, { afterSeq: 3 })).toEqual([]);
      expect(await log.read(sessionId, { afterSeq: 0 })).toHaveLength(3);
    });

    it('does not change what it read when the caller changes it', async () => {
      const { log, fence, newSession } = subject;
      const sessionId = await newSession();
      await log.append(sessionId, [user('a')], fence);
      const [item] = await log.read(sessionId);
      (item as { text: string }).text = 'changed';
      const [again] = await log.read(sessionId);
      expect(again).toMatchObject({ text: 'a' });
    });

    describe('dedupe', () => {
      it.each<[string, (callId: string) => ItemBody]>([
        ['tool_call', toolCall],
        ['approval', approval],
        ['tool_started', started],
        ['tool_result', result],
      ])('refuses a second %s for the same call', async (_kind, make) => {
        const { log, fence, newSession } = subject;
        const sessionId = await newSession();
        await log.append(sessionId, [make('call-1')], fence);
        await expect(
          log.append(sessionId, [make('call-1')], fence),
        ).rejects.toBeInstanceOf(DuplicateItem);
      });

      it('writes none of the items of an append that has a duplicate', async () => {
        const { log, fence, newSession } = subject;
        const sessionId = await newSession();
        await log.append(sessionId, [toolCall('call-1')], fence);
        await expect(
          log.append(
            sessionId,
            [user('new'), toolCall('call-2'), toolCall('call-1')],
            fence,
          ),
        ).rejects.toMatchObject({ dedupeKey: 'tool_call:call-1' });
        expect(await log.read(sessionId)).toHaveLength(1);
        // The sequence has no gap after the refused append.
        const [next] = await log.append(sessionId, [toolCall('call-2')], fence);
        expect(next.seq).toBe(2);
      });

      it('refuses a duplicate inside one append', async () => {
        const { log, fence, newSession } = subject;
        const sessionId = await newSession();
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
        const { log, fence, newSession } = subject;
        const one = await newSession();
        const two = await newSession();
        await log.append(
          one,
          [toolCall('call-1'), approval('call-1'), started('call-1')],
          fence,
        );
        await log.append(one, [result('call-1')], fence);
        await log.append(two, [toolCall('call-1')], fence);
        expect(await log.read(one)).toHaveLength(4);
        expect(await log.read(two)).toHaveLength(1);
      });

      it('allows the items that have no key as often as needed', async () => {
        const { log, fence, newSession } = subject;
        const sessionId = await newSession();
        await log.append(sessionId, [user('same'), user('same')], fence);
        await log.append(sessionId, [user('same')], fence);
        expect(await log.read(sessionId)).toHaveLength(3);
      });
    });

    describe('lease', () => {
      it('refuses a write of an owner that does not hold the lease', async () => {
        const { log, staleFence, newSession } = subject;
        const sessionId = await newSession();
        await expect(
          log.append(sessionId, [user('a')], staleFence),
        ).rejects.toBeInstanceOf(LeaseLost);
        await expect(
          log.append(sessionId, [user('a')], staleFence),
        ).rejects.toMatchObject({ runId: staleFence.runId });
      });

      it('writes nothing for a refused write', async () => {
        const { log, fence, staleFence, newSession } = subject;
        const sessionId = await newSession();
        await log.append(sessionId, [user('a')], fence);
        await expect(
          log.append(sessionId, [user('b'), user('c')], staleFence),
        ).rejects.toBeInstanceOf(LeaseLost);
        expect(await log.read(sessionId)).toHaveLength(1);
        const [next] = await log.append(sessionId, [user('d')], fence);
        expect(next.seq).toBe(2);
      });
    });
  });
}

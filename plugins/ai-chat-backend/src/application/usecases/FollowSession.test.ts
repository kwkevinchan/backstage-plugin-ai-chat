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

import type { Item } from '@kwkevinchan/ai-chat-harness';
import { FollowSession } from './FollowSession';

const jane = { userRef: 'user:default/jane' } as any;
const base = (seq: number) => ({
  sessionId: 's1',
  seq,
  runId: 'r1',
  createdAt: 'x',
});
const user = (seq: number): Item =>
  ({ ...base(seq), kind: 'user_message', text: `m${seq}` } as Item);
const inserted = (seq: number): Item =>
  ({
    ...base(seq),
    kind: 'user_message',
    text: `m${seq}`,
    delivery: 'inserted',
  } as Item);
const output = (seq: number, readUpToSeq: number): Item =>
  ({ ...base(seq), kind: 'agent_message', text: 'a', readUpToSeq } as Item);

function follow(log: Item[], afterSeq?: number) {
  const useCase = new FollowSession({
    sessions: {
      get: async () => ({ id: 's1', ownerRef: 'user:default/jane' }),
    } as any,
    runs: {
      findActive: async () => ({ id: 'r1', status: 'running' }),
    } as any,
    items: { read: async () => log } as any,
    supervisor: { subscribe: () => (async function* () {})() } as any,
  });
  return useCase.execute({ principal: jane, sessionId: 's1', afterSeq });
}

describe('FollowSession and the inserted messages', () => {
  const log = [user(1), output(2, 1), inserted(3), output(4, 3), inserted(5)];

  it('hands over every inserted message of the run when afterSeq is not set', async () => {
    const handle = await follow(log);
    expect(handle!.inserted.map(i => i.seq)).toEqual([3, 5]);
  });

  it('hands over a message that was left out of the items and is read by an output after afterSeq', async () => {
    const handle = await follow([user(1), output(2, 1), inserted(3)], 3);
    expect(handle!.items).toEqual([]);
    expect(handle!.inserted.map(i => i.seq)).toEqual([3]);
  });

  it('leaves out a message that an output up to afterSeq read: the client has it', async () => {
    const handle = await follow(log, 4);
    expect(handle!.items.map(i => i.seq)).toEqual([5]);
    expect(handle!.inserted.map(i => i.seq)).toEqual([5]);
  });
});

const owner = { id: 's1', ownerRef: 'user:default/jane' };

function sessionDeps(
  over: {
    run?: { id: string; status: string; endReason?: string } | undefined;
    log?: Item[];
    subscribe?: () => AsyncIterable<unknown> | undefined;
    openDraft?: () => { draftId: string; text: string } | undefined;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    getRun?: () => Promise<{ id: string; status: string; endReason?: string }>;
  } = {},
) {
  const reads: number[] = [];
  let log = over.log ?? [];
  const useCase = new FollowSession({
    sessions: { get: async () => owner } as any,
    runs: {
      findActive: async () =>
        over.run === undefined && !('run' in over)
          ? { id: 'r1', status: 'running' }
          : over.run,
      get: over.getRun ?? (async () => ({ id: 'r1', status: 'running' })),
    } as any,
    items: {
      read: async () => {
        reads.push(1);
        return log;
      },
    } as any,
    supervisor: {
      subscribe:
        over.subscribe ??
        (() => ({
          buffered: () => [],
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ value: undefined, done: true }),
          }),
        })),
      openDraft: over.openDraft,
    } as any,
    sleep: over.sleep,
    pollIntervalMs: 1000,
  });
  return {
    useCase,
    reads,
    setLog: (next: Item[]) => {
      log = next;
    },
  };
}

describe('FollowSession reconnect', () => {
  it('subscribes before it reads, so an item written in between is not lost', async () => {
    const log: Item[] = [];
    let subscribed = false;
    const events = (async function* () {})();
    const useCase = new FollowSession({
      sessions: { get: async () => owner } as any,
      runs: {
        findActive: async () => ({ id: 'r1', status: 'running' }),
      } as any,
      items: {
        read: async () => {
          expect(subscribed).toBe(true);
          log.push(output(1, 0));
          return log;
        },
      } as any,
      supervisor: {
        subscribe: () => {
          subscribed = true;
          return events;
        },
        openDraft: () => undefined,
      } as any,
    });
    const handle = await useCase.execute({ principal: jane, sessionId: 's1' });
    expect(handle!.items.map(item => item.seq)).toEqual([1]);
    expect(handle!.events).toBe(events);
  });

  it('sends the text accumulated at subscribe time and not the deltas already queued', async () => {
    const queued = [
      { type: 'item.delta', draftId: 'd', text: 'lo' },
      { type: 'item.delta', draftId: 'd', text: '!' },
    ];
    const { useCase } = sessionDeps({
      log: [user(1)],
      openDraft: () => ({ draftId: 'd', text: 'Hel' }),
      subscribe: () =>
        ({
          buffered: () => queued,
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ value: undefined, done: true }),
          }),
        } as any),
    });
    const handle = await useCase.execute({ principal: jane, sessionId: 's1' });
    expect(handle!.resumeText).toEqual({ draftId: 'd', text: 'Hel' });

    const done = sessionDeps({
      log: [user(1), output(2, 1)],
      openDraft: () => ({ draftId: 'd', text: 'Hel' }),
      subscribe: () =>
        ({
          buffered: () => [
            { type: 'item.completed', draftId: 'd', item: output(2, 1) },
          ],
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ value: undefined, done: true }),
          }),
        } as any),
    });
    const finished = await done.useCase.execute({
      principal: jane,
      sessionId: 's1',
    });
    expect(finished!.resumeText).toBeUndefined();
  });

  it('polls a run on another backend once a second and yields only completed items', async () => {
    let release: (() => void) | undefined;
    const sleeps: number[] = [];
    const { useCase, setLog } = sessionDeps({
      log: [user(1)],
      subscribe: () => undefined,
      sleep: (ms, signal) => {
        sleeps.push(ms);
        return new Promise(resolve => {
          if (signal.aborted) {
            resolve();
            return;
          }
          release = () => resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const handle = await useCase.execute({ principal: jane, sessionId: 's1' });
    expect(handle!.items.map(item => item.seq)).toEqual([1]);
    const iterator = handle!.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    expect(sleeps).toEqual([1000]);
    setLog([user(1), output(2, 1)]);
    release!();
    const first = await pending;
    expect(first.value).toEqual({
      type: 'item.completed',
      item: expect.objectContaining({ seq: 2, kind: 'agent_message' }),
    });
    expect(JSON.stringify(first.value)).not.toContain('item.delta');

    const again = iterator.next();
    await Promise.resolve();
    expect(sleeps).toEqual([1000, 1000]);
    setLog([user(1), output(2, 1), output(3, 1)]);
    release!();
    const second = await again;
    expect(second.value).toMatchObject({
      type: 'item.completed',
      item: { seq: 3 },
    });
    await iterator.return?.();
  });

  it('ends the poll with the status stored for the run', async () => {
    const tool = {
      ...base(2),
      kind: 'tool_call',
      callId: 'c1',
      toolId: 'demo:write',
      input: {},
      schemaHash: 'h',
      policy: 'ask',
      readOnly: false,
      step: 1,
      position: 0,
    } as Item;
    const cases: Array<{
      status: string;
      endReason?: string;
      log: Item[];
      outcome: object;
    }> = [
      {
        status: 'waiting_approval',
        log: [user(1), tool],
        outcome: {
          status: 'waiting_approval',
          pending: [expect.objectContaining({ callId: 'c1' })],
        },
      },
      {
        status: 'completed',
        endReason: 'timeout',
        log: [user(1), output(2, 1)],
        outcome: { status: 'completed', endReason: 'timeout' },
      },
      {
        status: 'failed',
        log: [user(1)],
        outcome: { status: 'failed', message: 'The run stopped.' },
      },
      {
        status: 'cancelled',
        log: [user(1)],
        outcome: { status: 'cancelled' },
      },
      {
        status: 'expired',
        log: [user(1)],
        outcome: { status: 'failed', message: 'The run stopped.' },
      },
    ];
    for (const next of cases) {
      let release: (() => void) | undefined;
      const { useCase } = sessionDeps({
        log: next.log,
        subscribe: () => undefined,
        getRun: async () => ({
          id: 'r1',
          status: next.status,
          ...(next.endReason && { endReason: next.endReason }),
        }),
        sleep: (_ms, signal) =>
          new Promise(resolve => {
            if (signal.aborted) {
              resolve();
              return;
            }
            release = () => resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          }),
      });
      const handle = await useCase.execute({
        principal: jane,
        sessionId: 's1',
      });
      const iterator = handle!.events[Symbol.asyncIterator]();
      const pending = iterator.next();
      await Promise.resolve();
      release!();
      const event = await pending;
      expect(event.value).toEqual({ type: 'run.ended', outcome: next.outcome });
      expect((await iterator.next()).done).toBe(true);
    }
  });

  it('returns nothing when there is no running run', async () => {
    for (const run of [
      undefined,
      { id: 'r1', status: 'waiting_approval' },
      { id: 'r1', status: 'completed' },
      { id: 'r1', status: 'failed' },
      { id: 'r1', status: 'expired' },
    ]) {
      const subscribe = jest.fn();
      const { useCase } = sessionDeps({ run, subscribe });
      await expect(
        useCase.execute({ principal: jane, sessionId: 's1' }),
      ).resolves.toBeUndefined();
      expect(subscribe).not.toHaveBeenCalled();
    }
  });

  it('rejects a principal that does not own the session', async () => {
    const { useCase } = sessionDeps();
    await expect(
      useCase.execute({
        principal: { userRef: 'user:default/mallory' } as any,
        sessionId: 's1',
      }),
    ).rejects.toMatchObject({ name: 'NotSessionOwner', sessionId: 's1' });
  });

  it('a poll leaves out items up to afterSeq', async () => {
    let release: (() => void) | undefined;
    const { useCase, setLog } = sessionDeps({
      log: [user(1), output(2, 1), inserted(3)],
      subscribe: () => undefined,
      sleep: (_ms, signal) =>
        new Promise(resolve => {
          release = () => resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const handle = await useCase.execute({
      principal: jane,
      sessionId: 's1',
      afterSeq: 2,
    });
    // Seq 1 and 2 are at or below afterSeq. Seq 3 was already stored.
    expect(handle!.items.map(item => item.seq)).toEqual([3]);
    expect(handle!.upToSeq).toBe(3);
    const iterator = handle!.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    setLog([user(1), output(2, 1), inserted(3), inserted(4), output(5, 4)]);
    release!();
    const events = [
      await pending,
      await iterator.next(),
      await iterator.next(),
    ];
    expect(events.map(event => event.value)).toEqual([
      {
        type: 'item.completed',
        item: expect.objectContaining({ seq: 4, kind: 'user_message' }),
      },
      { type: 'message.read', item: expect.objectContaining({ seq: 4 }) },
      {
        type: 'item.completed',
        item: expect.objectContaining({ seq: 5, kind: 'agent_message' }),
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/"seq":[123][,}]/);
    await iterator.return?.();
  });

  it('stops polling when the reader returns, and does not read again', async () => {
    let release: (() => void) | undefined;
    const { useCase, reads } = sessionDeps({
      log: [user(1)],
      subscribe: () => undefined,
      sleep: (_ms, signal) =>
        new Promise(resolve => {
          release = () => resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const handle = await useCase.execute({ principal: jane, sessionId: 's1' });
    expect(reads).toHaveLength(1);
    const iterator = handle!.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    await iterator.return?.();
    await pending;
    release?.();
    await Promise.resolve();
    expect(reads).toHaveLength(1);
  });
});

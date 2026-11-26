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
  AdvanceRun,
  type Item,
  type RunOutcome,
} from '@kwkevinchan/ai-chat-harness';
import { OwnerOrShareAccessControl } from '../OwnerOrShareAccessControl';
import { RunSupervisor } from '../RunSupervisor';
import { FollowSession } from './FollowSession';

/** The session has no share: only its owner reads it. */
const ownerOnly = {
  shares: { listBySession: async () => [] } as any,
  access: new OwnerOrShareAccessControl(),
  clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
};

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
    ...ownerOnly,
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
    openDraft?: () =>
      | { draftId: string; text: string; emittedSeq?: number }
      | undefined;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    getRun?: () => Promise<{ id: string; status: string; endReason?: string }>;
    readLog?: (
      sessionId: string,
      opts?: { afterSeq?: number },
    ) => Promise<Item[]>;
    logger?: { warn: jest.Mock };
  } = {},
) {
  const reads: number[] = [];
  const readCalls: Array<{ afterSeq?: number } | undefined> = [];
  let log = over.log ?? [];
  const useCase = new FollowSession({
    ...ownerOnly,
    sessions: { get: async () => owner } as any,
    runs: {
      findActive: async () =>
        over.run === undefined && !('run' in over)
          ? { id: 'r1', status: 'running' }
          : over.run,
      get: over.getRun ?? (async () => ({ id: 'r1', status: 'running' })),
    } as any,
    items: {
      read: async (sessionId: string, opts?: { afterSeq?: number }) => {
        reads.push(1);
        readCalls.push(opts);
        if (over.readLog) return over.readLog(sessionId, opts);
        const after = opts?.afterSeq ?? 0;
        return log.filter(item => item.seq > after);
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
    logger: over.logger as any,
    sleep: over.sleep,
    pollIntervalMs: 1000,
  });
  return {
    useCase,
    reads,
    readCalls,
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
      ...ownerOnly,
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
        principal: {
          userRef: 'user:default/mallory',
          ownershipRefs: ['user:default/mallory'],
        } as any,
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

  it('polls with afterSeq and only reads the full log on waiting_approval', async () => {
    let release: (() => void) | undefined;
    let status = 'running';
    const tool = {
      ...base(3),
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
    const { useCase, setLog, readCalls } = sessionDeps({
      log: [user(1)],
      subscribe: () => undefined,
      getRun: async () => ({ id: 'r1', status }),
      sleep: (_ms, signal) =>
        new Promise(resolve => {
          release = () => resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const handle = await useCase.execute({ principal: jane, sessionId: 's1' });
    expect(readCalls).toEqual([undefined]);

    const iterator = handle!.events[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();
    setLog([user(1), output(2, 1)]);
    release!();
    await first;
    expect(readCalls).toEqual([undefined, { afterSeq: 1 }]);

    const second = iterator.next();
    await Promise.resolve();
    status = 'waiting_approval';
    setLog([user(1), output(2, 1), tool]);
    release!();
    const toolEvent = await second;
    expect(toolEvent.value).toMatchObject({
      type: 'item.completed',
      item: { seq: 3 },
    });
    const endEvent = await iterator.next();
    expect(endEvent.value).toEqual({
      type: 'run.ended',
      outcome: {
        status: 'waiting_approval',
        pending: [expect.objectContaining({ callId: 'c1' })],
      },
    });
    expect(readCalls).toEqual([undefined, { afterSeq: 1 }, undefined]);
  });

  it('retries transient poll errors with a warning and fails only after repeated errors', async () => {
    const releases: Array<() => void> = [];
    const logger = { warn: jest.fn() };
    let pollAttempt = 0;
    const { useCase, setLog } = sessionDeps({
      log: [user(1)],
      subscribe: () => undefined,
      logger,
      getRun: async () => {
        pollAttempt += 1;
        if (pollAttempt <= 2) throw new Error('db busy');
        if (pollAttempt === 3) return { id: 'r1', status: 'running' };
        throw new Error('db gone');
      },
      sleep: (_ms, signal) =>
        new Promise(resolve => {
          releases.push(() => resolve());
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });

    const handle = await useCase.execute({ principal: jane, sessionId: 's1' });
    const iterator = handle!.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    // Poll 1: fails -> warns and sleeps again.
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Poll 2: fails -> warns and sleeps again.
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // Poll 3: succeeds -> resets failure count and delivers item.
    setLog([user(1), output(2, 1)]);
    releases.shift()!();
    const itemEvent = await pending;
    expect(itemEvent.value).toMatchObject({
      type: 'item.completed',
      item: { seq: 2 },
    });

    // Three consecutive errors after recovery stop the poll.
    const failing = iterator.next();
    await Promise.resolve();
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    releases.shift()!();
    await expect(failing).rejects.toThrow('db gone');
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('does not duplicate text when items.append stored the message before item.completed is emitted', async () => {
    const log: Item[] = [user(1)];
    let markAppended!: () => void;
    const appended = new Promise<void>(resolve => {
      markAppended = resolve;
    });
    let releaseCompleted!: () => void;
    const gateCompleted = new Promise<void>(resolve => {
      releaseCompleted = resolve;
    });

    const supervisor = new RunSupervisor({
      advance: {
        execute: async function* storedBeforeCompleted() {
          yield { type: 'run.started', runId: 'r1' };
          yield { type: 'step.started', step: 1 };
          yield {
            type: 'item.started',
            draftId: 'd1',
            kind: 'agent_message',
          };
          yield { type: 'item.delta', draftId: 'd1', text: 'Hello' };
          const stored = output(2, 1);
          (stored as any).text = 'Hello';
          log.push(stored);
          markAppended();
          await gateCompleted;
          yield { type: 'item.completed', draftId: 'd1', item: stored };
          yield { type: 'step.ended', step: 1 };
          const outcome: RunOutcome = { status: 'completed' };
          yield { type: 'run.ended', outcome };
          return outcome;
        } as unknown as AdvanceRun['execute'],
      },
      runs: {
        transition: async () => ({ id: 'r1', status: 'completed' }),
      } as any,
      logger: { warn: jest.fn(), error: jest.fn() } as any,
    });

    const loopHandle = supervisor.launch(
      {
        id: 'r1',
        sessionId: 's1',
        status: 'running',
        cancelRequested: false,
        usage: { stepsUsed: 0, toolCallsUsed: 0, elapsedSeconds: 0 },
        fence: { runId: 'r1', leaseOwner: 'lease-1' },
      } as any,
      { ctx: { principal: jane } } as any,
    );

    await appended;

    const useCase = new FollowSession({
      ...ownerOnly,
      sessions: { get: async () => owner } as any,
      runs: {
        findActive: async () => ({ id: 'r1', status: 'running' }),
      } as any,
      items: {
        read: async (_id: string, opts?: { afterSeq?: number }) =>
          log.filter(item => item.seq > (opts?.afterSeq ?? 0)),
      } as any,
      supervisor,
    });

    const followed = await useCase.execute({
      principal: jane,
      sessionId: 's1',
    });
    expect(followed!.items.map(i => i.seq)).toEqual([1, 2]);
    expect(followed!.upToSeq).toBe(2);
    expect(followed!.resumeText).toBeUndefined();

    const seen: unknown[] = [];
    releaseCompleted();
    for await (const event of followed!.events) {
      seen.push(event);
    }
    await loopHandle.done;

    expect(seen).toContainEqual({
      type: 'item.completed',
      draftId: 'd1',
      item: expect.objectContaining({ seq: 2, kind: 'agent_message' }),
    });
  });

  it('still sends resumeText on a resumed run that already has an earlier agent_message', async () => {
    const earlier = output(2, 1);
    const log: Item[] = [user(1), earlier];
    let markDraftOpen!: () => void;
    const draftOpen = new Promise<void>(resolve => {
      markDraftOpen = resolve;
    });
    let releaseEnd!: () => void;
    const gateEnd = new Promise<void>(resolve => {
      releaseEnd = resolve;
    });

    const supervisor = new RunSupervisor({
      advance: {
        execute: async function* storedBeforeCompleted() {
          yield {
            type: 'item.started',
            draftId: 'd2',
            kind: 'agent_message',
          };
          yield { type: 'item.delta', draftId: 'd2', text: 'Next' };
          markDraftOpen();
          await gateEnd;
          const outcome: RunOutcome = { status: 'completed' };
          yield { type: 'run.ended', outcome };
          return outcome;
        } as unknown as AdvanceRun['execute'],
      },
      runs: {
        transition: async () => ({ id: 'r1', status: 'completed' }),
      } as any,
      logger: { warn: jest.fn(), error: jest.fn() } as any,
    });

    const loopHandle = supervisor.launch(
      {
        id: 'r1',
        sessionId: 's1',
        status: 'running',
        cancelRequested: false,
        usage: { stepsUsed: 1, toolCallsUsed: 1, elapsedSeconds: 1 },
        fence: { runId: 'r1', leaseOwner: 'lease-2' },
      } as any,
      { ctx: { principal: jane } } as any,
      { initialSeq: 2 },
    );

    await draftOpen;

    const useCase = new FollowSession({
      ...ownerOnly,
      sessions: { get: async () => owner } as any,
      runs: {
        findActive: async () => ({ id: 'r1', status: 'running' }),
      } as any,
      items: {
        read: async (_id: string, opts?: { afterSeq?: number }) =>
          log.filter(item => item.seq > (opts?.afterSeq ?? 0)),
      } as any,
      supervisor,
    });

    const followed = await useCase.execute({
      principal: jane,
      sessionId: 's1',
    });
    expect(followed!.resumeText).toEqual({ draftId: 'd2', text: 'Next' });

    releaseEnd();
    for await (const _ of followed!.events) {
      // drain
    }
    await loopHandle.done;
  });
});

describe('FollowSession for a sharee', () => {
  const bob = {
    userRef: 'user:default/bob',
    ownershipRefs: ['user:default/bob'],
  } as any;
  const at = (seq: number, body: object): Item =>
    ({ ...base(seq), ...body } as Item);
  const call = (seq: number, callId: string, toolId: string) =>
    at(seq, {
      kind: 'tool_call',
      callId,
      toolId,
      input: { name: 'x' },
      schemaHash: 'h',
      policy: 'allow',
      step: 1,
      index: 0,
    });
  const result = (seq: number, callId: string) =>
    at(seq, {
      kind: 'tool_result',
      callId,
      status: 'ok',
      output: { secret: seq },
      message: `secret ${seq}`,
    });
  const liveShare = (partial: object = {}) => ({
    id: 'sh1',
    sessionId: 's1',
    subjectRef: 'user:default/bob',
    outputsUpToSeq: 3,
    expiresAt: '2026-01-02T00:00:00.000Z',
    createdBy: 'user:default/jane',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  });

  function world(options: { shares: object[]; status?: string }) {
    const log: Item[] = [user(1), call(2, 'c1', 'demo:read'), result(3, 'c1')];
    const state = {
      log,
      shares: options.shares,
      status: options.status ?? 'running',
      now: '2026-01-01T12:00:00.000Z',
    };
    const subscribe = jest.fn();
    const useCase = new FollowSession({
      sessions: {
        get: async () => ({ id: 's1', ownerRef: 'user:default/jane' }),
      } as any,
      shares: { listBySession: async () => state.shares } as any,
      access: new OwnerOrShareAccessControl(),
      clock: { now: () => new Date(state.now) },
      runs: {
        findActive: async () => ({ id: 'r1', status: 'running' }),
        get: async () => ({ id: 'r1', status: state.status }),
      } as any,
      items: {
        read: async (_id: string, opts?: { afterSeq?: number }) =>
          state.log.filter(item => item.seq > (opts?.afterSeq ?? 0)),
      } as any,
      // The loop is on this backend: a sharee still gets the poll.
      supervisor: { subscribe, openDraft: jest.fn() } as any,
      sleep: async () => undefined,
    });
    return { state, subscribe, useCase };
  }

  async function collect(events: AsyncIterable<any>) {
    const seen: any[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  }

  it('polls with the rules of the share, even when the run is on this backend', async () => {
    const { state, subscribe, useCase } = world({ shares: [liveShare()] });
    const followed = await useCase.execute({ principal: bob, sessionId: 's1' });
    expect(subscribe).not.toHaveBeenCalled();
    expect(followed!.items.map(item => item.seq)).toEqual([1, 2, 3]);
    expect(followed!.items[2]).toMatchObject({ output: { secret: 3 } });

    state.log.push(call(4, 'c2', 'demo:read'), result(5, 'c2'));
    state.status = 'completed';
    const events = await collect(followed!.events);
    const completed = events.filter(event => event.type === 'item.completed');
    expect(completed.map(event => event.item.seq)).toEqual([4, 5]);
    expect(completed[1].item).toEqual({
      ...base(5),
      kind: 'tool_result',
      callId: 'c2',
      status: 'ok',
      output: 'not shared',
    });
    expect(JSON.stringify(events)).not.toContain('secret 5');
    expect(events[events.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
  });

  it('ends without a call to decide when the run waits for an approval', async () => {
    const { state, useCase } = world({ shares: [liveShare()] });
    const followed = await useCase.execute({ principal: bob, sessionId: 's1' });
    state.log.push(call(4, 'c2', 'demo:write'));
    state.status = 'waiting_approval';
    const events = await collect(followed!.events);
    expect(events[events.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'waiting_approval', pending: [] },
    });
  });

  it('answers nothing for a snapshot or a live share past its expiry', async () => {
    const snapshot = world({ shares: [liveShare({ upToSeq: 3 })] });
    expect(
      await snapshot.useCase.execute({ principal: bob, sessionId: 's1' }),
    ).toBeUndefined();
    const expired = world({ shares: [liveShare()] });
    expired.state.now = '2026-01-02T00:00:00.001Z';
    expect(
      await expired.useCase.execute({ principal: bob, sessionId: 's1' }),
    ).toBeUndefined();
  });

  it('ends the stream, with no end of the run, when the share is cancelled or expires', async () => {
    for (const change of [
      (state: any) => {
        state.shares = [liveShare({ revokedAt: '2026-01-01T12:00:00.000Z' })];
      },
      (state: any) => {
        state.now = '2026-01-02T00:00:00.001Z';
      },
    ]) {
      const { state, useCase } = world({ shares: [liveShare()] });
      const followed = await useCase.execute({
        principal: bob,
        sessionId: 's1',
      });
      change(state);
      state.log.push(call(4, 'c2', 'demo:read'));
      expect(await collect(followed!.events)).toEqual([]);
    }
  });

  it('refuses someone no share names', async () => {
    const { useCase } = world({
      shares: [liveShare({ subjectRef: 'user:default/cara' })],
    });
    await expect(
      useCase.execute({ principal: bob, sessionId: 's1' }),
    ).rejects.toMatchObject({ name: 'NotSessionOwner' });
  });
});

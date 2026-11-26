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
  LeaseLost,
  type AdvanceRun,
  type HarnessEvent,
  type RunFence,
  type RunOutcome,
} from '@kwkevinchan/ai-chat-harness';
import { UnreadMessages, type LeasedRun } from '../domain';
import type { HostEvent } from './hostEvents';
import {
  RunSupervisor,
  type LaunchRequest,
  type RunSupervisorDeps,
} from './RunSupervisor';
import type { Logger, RunRepository } from './ports';

// The supervisor against a scripted loop and a recording run repository: the
// order of what it writes and publishes, and what it does with fences. The
// tests with a real database are in `src/integration`.

const request = {} as LaunchRequest;

const leased = (runId: string, leaseOwner: string): LeasedRun =>
  ({
    id: runId,
    sessionId: 's1',
    status: 'running',
    usage: { stepsUsed: 0, toolCallsUsed: 0, elapsedSeconds: 0 },
    cancelRequested: false,
    startedAt: 'x',
    leaseOwner,
    fence: { runId, leaseOwner },
  } as LeasedRun);

function setup(
  loop: (
    fence: RunFence,
    signal: AbortSignal,
  ) => AsyncGenerator<HarnessEvent, RunOutcome>,
  overrides: Partial<Record<keyof RunRepository, jest.Mock>> = {},
  extra: Partial<RunSupervisorDeps> = {},
) {
  const calls: string[] = [];
  const runs = {
    transition: jest.fn(async (id: string, to: string, opts: any) => {
      calls.push(`transition ${id} ${to} ${opts?.leaseOwner ?? '-'}`);
    }),
    heartbeat: jest.fn(async () => ({ cancelRequested: false })),
    ...overrides,
  } as unknown as RunRepository;
  const logger: Logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const execute = jest.fn((req: any) => loop(req.fence, req.signal));
  const advance = { execute } as unknown as Pick<AdvanceRun, 'execute'>;
  const supervisor = new RunSupervisor({
    advance,
    runs,
    logger,
    heartbeatMs: 10,
    ...extra,
  });
  return { supervisor, runs: runs as any, logger, calls, execute };
}

async function* ending(
  outcome: RunOutcome,
): AsyncGenerator<HarnessEvent, RunOutcome> {
  yield { type: 'run.started', runId: 'r1' };
  yield { type: 'run.ended', outcome };
  return outcome;
}

async function* blocked(
  signal: AbortSignal,
): AsyncGenerator<HarnessEvent, RunOutcome> {
  yield { type: 'run.started', runId: 'r1' };
  await new Promise<void>(resolve =>
    signal.addEventListener('abort', () => resolve()),
  );
  const outcome: RunOutcome = { status: 'cancelled' };
  yield { type: 'run.ended', outcome };
  return outcome;
}

describe('RunSupervisor', () => {
  it('writes the status of the run before it tells the subscribers that the run ended', async () => {
    const { supervisor, calls } = setup(() =>
      ending({ status: 'waiting_approval', pending: [] }),
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    for await (const event of handle.events) {
      if (event.type === 'run.ended') {
        calls.push('subscriber saw run.ended');
      }
    }
    expect(calls).toEqual([
      'transition r1 waiting_approval lease-1',
      'subscriber saw run.ended',
    ]);
  });

  it('names the session on a normal end, after the subscribers see that it ended', async () => {
    let named = false;
    let releaseName!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseName = resolve;
    });
    const { supervisor, calls } = setup(
      () => ending({ status: 'completed' }),
      {
        transition: jest.fn(async (id: string, to: string, opts: any) => {
          calls.push(`transition ${id} ${to} ${opts?.leaseOwner ?? '-'}`);
          return { id, sessionId: 's1', status: to };
        }),
      },
      {
        nameSession: async info => {
          expect(info.outcome).toEqual({ status: 'completed' });
          expect(info.signal.aborted).toBe(false);
          calls.push('nameSession');
          await gate;
          named = true;
        },
      },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const events: HostEvent[] = [];
    // The stream ends once run.ended is published, while naming is still going:
    // a client that reads the stream does not wait for the title.
    let sawEnd = false;
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run.ended') {
        sawEnd = true;
        calls.push('subscriber saw run.ended');
      }
    }
    expect(sawEnd).toBe(true);
    expect(named).toBe(false);
    expect(events[events.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    releaseName();
    await handle.done;
    expect(named).toBe(true);
    expect(calls).toEqual([
      'transition r1 completed lease-1',
      'nameSession',
      'subscriber saw run.ended',
    ]);
  });

  it.each([
    { status: 'waiting_approval' as const, pending: [] },
    { status: 'completed' as const, endReason: 'max_steps' as const },
    { status: 'failed' as const, message: 'm' },
    { status: 'cancelled' as const },
  ])('does not name the session for %j', async outcome => {
    const nameSession = jest.fn(async () => undefined);
    const { supervisor } = setup(
      () => ending(outcome),
      {
        transition: jest.fn(async () => ({ id: 'r1', sessionId: 's1' })),
      },
      { nameSession },
    );
    await supervisor.launch(leased('r1', 'lease-1'), request).done;
    expect(nameSession).not.toHaveBeenCalled();
  });

  it('still publishes a completed end when naming the session throws', async () => {
    const { supervisor, logger } = setup(
      () => ending({ status: 'completed' }),
      {
        transition: jest.fn(async () => ({
          id: 'r1',
          sessionId: 's1',
          status: 'completed',
        })),
      },
      {
        nameSession: async () => {
          throw new Error('title model down');
        },
      },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const seen: HostEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(seen[seen.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    await handle.done;
    expect(logger.error).toHaveBeenCalledWith(
      'Could not name the session',
      expect.objectContaining({ runId: 'r1', error: 'title model down' }),
    );
  });

  it.each([
    [{ status: 'completed' as const }, 'completed'],
    [
      { status: 'completed' as const, endReason: 'timeout' as const },
      'completed',
    ],
    [{ status: 'cancelled' as const }, 'cancelled'],
    [{ status: 'failed' as const, message: 'm' }, 'failed'],
  ])(
    'maps the outcome %j to the status %s, with the lease owner',
    async (outcome, status) => {
      const { supervisor, runs } = setup(() => ending(outcome));
      await supervisor.launch(leased('r1', 'lease-1'), request).done;
      expect(runs.transition).toHaveBeenCalledWith(
        'r1',
        status,
        expect.objectContaining({ leaseOwner: 'lease-1' }),
      );
    },
  );

  it('logs the name and the status of the cause of a failure and of a failed summary, not its text, and keeps it from the subscribers', async () => {
    const { supervisor, logger } = setup(async function* () {
      yield { type: 'summary.failed', cause: new Error('provider said x') };
      const outcome: RunOutcome = {
        status: 'failed',
        message: 'The model call failed.',
        cause: Object.assign(new TypeError('provider said y'), {
          status: 502,
        }),
      };
      yield { type: 'run.ended', outcome };
      return outcome;
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const seen: HostEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(logger.warn).toHaveBeenCalledWith('A summary could not be made', {
      runId: 'r1',
      errorName: 'Error',
    });
    expect(logger.error).toHaveBeenCalledWith('A run failed', {
      runId: 'r1',
      errorName: 'TypeError',
      errorStatus: 502,
    });
    expect(
      JSON.stringify([
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
      ]),
    ).not.toContain('provider said');
    expect(seen).toEqual([
      { type: 'summary.failed' },
      {
        type: 'run.ended',
        outcome: { status: 'failed', message: 'The model call failed.' },
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain('provider said');
  });

  it('keeps the cause of a port error from the subscribers too', async () => {
    const { supervisor } = setup(async function* () {
      yield { type: 'run.started', runId: 'r1' };
      throw new Error('secret text of the database');
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const seen: HostEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(JSON.stringify(seen)).not.toContain('secret');
    expect(seen[seen.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'failed', message: 'The run stopped.' },
    });
  });

  it('does not stop the loop when a renewal fails for another reason than a lost lease', async () => {
    let beats = 0;
    let aborted = false;
    const { supervisor, runs, logger } = setup(
      async function* (_fence, signal) {
        yield { type: 'run.started', runId: 'r1' };
        const until = Date.now() + 2000;
        while (beats < 4 && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        aborted = signal.aborted;
        const outcome: RunOutcome = { status: 'completed' };
        yield { type: 'run.ended', outcome };
        return outcome;
      },
      {
        heartbeat: jest.fn(async () => {
          beats += 1;
          if (beats === 2) throw new Error('connection timeout');
          return { cancelRequested: false };
        }),
      },
    );
    await supervisor.launch(leased('r1', 'lease-1'), request).done;
    expect(beats).toBeGreaterThanOrEqual(4);
    expect(aborted).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not renew the lease of a run',
      expect.objectContaining({ error: 'connection timeout' }),
    );
    expect(runs.transition).toHaveBeenCalledWith(
      'r1',
      'completed',
      expect.anything(),
    );
  });

  it('cancels a run whose stop request came after the last heartbeat of the loop, when it waits for an approval', async () => {
    const { supervisor, runs } = setup(
      () => ending({ status: 'waiting_approval', pending: [] }),
      {
        transition: jest.fn(async (id: string, to: string) => {
          return { id, status: to, cancelRequested: to === 'waiting_approval' };
        }),
      },
    );
    await supervisor.launch(leased('r1', 'lease-1'), request).done;
    expect(runs.transition).toHaveBeenNthCalledWith(
      1,
      'r1',
      'waiting_approval',
      { leaseOwner: 'lease-1' },
    );
    expect(runs.transition).toHaveBeenNthCalledWith(2, 'r1', 'cancelled', {
      endReason: 'user',
    });
  });

  it('tells the subscribers the run is cancelled, not waiting, when a stop request turns the wait into a cancellation', async () => {
    const pending = [{ kind: 'tool_call', callId: 'c1' }] as any;
    const { supervisor } = setup(
      () => ending({ status: 'waiting_approval', pending }),
      {
        transition: jest.fn(async (id: string, to: string) => ({
          id,
          status: to,
          cancelRequested: to === 'waiting_approval',
        })),
      },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const ended: HarnessEvent[] = [];
    for await (const event of handle.events) {
      if (event.type === 'run.ended') ended.push(event);
    }
    expect(ended).toEqual([
      { type: 'run.ended', outcome: { status: 'cancelled' } },
    ]);
  });

  it('tells the subscribers the run waits for an approval when no stop request came', async () => {
    const pending = [{ kind: 'tool_call', callId: 'c1' }] as any;
    const { supervisor } = setup(() =>
      ending({ status: 'waiting_approval', pending }),
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const ended: HarnessEvent[] = [];
    for await (const event of handle.events) {
      if (event.type === 'run.ended') ended.push(event);
    }
    expect(ended).toEqual([
      { type: 'run.ended', outcome: { status: 'waiting_approval', pending } },
    ]);
  });

  it('keeps the fence of a run until its loop ends, and drops it when the loop throws', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const { supervisor } = setup(async function* () {
      yield { type: 'run.started', runId: 'r1' };
      await gate;
      throw new LeaseLost('r1');
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    expect(supervisor.activeRunIds()).toEqual(['r1']);
    release();
    await handle.done;
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it('a loop that ends does not remove the fence of the loop that replaced it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let n = 0;
    const { supervisor } = setup(async function* (_fence, signal) {
      n += 1;
      if (n === 1) {
        // The first loop waits, then ends.
        yield { type: 'run.started', runId: 'r1' };
        await gate;
        const outcome: RunOutcome = { status: 'completed' };
        yield { type: 'run.ended', outcome };
        return outcome;
      }
      return yield* blocked(signal);
    });
    const first = supervisor.launch(leased('r1', 'lease-1'), request);
    // The run is carried on with a new lease while the old loop is closing.
    const second = supervisor.launch(leased('r1', 'lease-2'), request);
    release();
    await first.done;
    expect(supervisor.activeRunIds()).toEqual(['r1']);
    expect(supervisor.cancel('r1')).toBe(true);
    await second.done;
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it('stops the loop when the timer finds the lease lost, and leaves the status alone', async () => {
    const { supervisor, runs } = setup((_fence, signal) => blocked(signal), {
      heartbeat: jest.fn(async () => {
        throw new LeaseLost('r1');
      }),
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    await handle.done;
    expect(runs.transition).toHaveBeenCalledWith(
      'r1',
      'cancelled',
      expect.anything(),
    );
    // The repository answers a transition without the lease with LeaseLost;
    // here it is only a call that the real one would refuse.
  });

  it('shutdown marks a run that is still going expired with the lease owner, and only then', async () => {
    const { supervisor, calls } = setup((_fence, signal) => blocked(signal));
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    expect(supervisor.accepting).toBe(true);
    await supervisor.shutdown(10);
    await handle.done;
    expect(supervisor.accepting).toBe(false);
    expect(calls).toEqual(['transition r1 expired lease-1']);
    expect(() => supervisor.launch(leased('r2', 'lease-9'), request)).toThrow(
      /shutting down/,
    );
  });

  it('shutdown skips a run whose lease is lost, and waits for one that is quick', async () => {
    const lost = setup((_fence, signal) => blocked(signal), {
      transition: jest.fn(async () => {
        throw new LeaseLost('r1');
      }),
    });
    const handle = lost.supervisor.launch(leased('r1', 'lease-1'), request);
    await lost.supervisor.shutdown(10);
    await handle.done;
    expect(lost.logger.error).not.toHaveBeenCalled();

    const quick = setup(() => ending({ status: 'completed' }));
    const done = quick.supervisor.launch(leased('r1', 'lease-1'), request);
    await quick.supervisor.shutdown(1000);
    await done.done;
    expect(quick.calls).toEqual(['transition r1 completed lease-1']);
  });

  it('subscribe gives a later subscriber the events from then on', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const { supervisor } = setup(async function* () {
      yield { type: 'run.started', runId: 'r1' };
      await gate;
      const outcome: RunOutcome = { status: 'completed' };
      yield { type: 'run.ended', outcome };
      return outcome;
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    await new Promise(resolve => setTimeout(resolve, 5));
    const late = supervisor.subscribe('r1')!;
    expect(supervisor.subscribe('nope')).toBeUndefined();
    release();
    const seen: string[] = [];
    for await (const event of late) seen.push(event.type);
    await handle.done;
    expect(seen).toEqual(['run.ended']);
  });

  it('gives no subscription once run.ended went out, so nobody waits for an end that will not come', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const { supervisor } = setup(async function* endedButRunning() {
      yield { type: 'run.started', runId: 'r1' };
      const outcome: RunOutcome = { status: 'completed' };
      yield { type: 'run.ended', outcome };
      // The loop is not over yet: the generator still has to return.
      await gate;
      return outcome;
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    for await (const event of handle.events) {
      if (event.type === 'run.ended') break;
    }
    expect(supervisor.activeRunIds()).toEqual(['r1']);
    expect(supervisor.subscribe('r1')).toBeUndefined();
    release();
    await handle.done;
  });
});

describe('RunSupervisor with inserted messages and the queue (PI-03)', () => {
  const principal = { userRef: 'user:default/jane' } as any;
  const withPrincipal = { ctx: { principal } } as unknown as LaunchRequest;
  const stored = (status: string) =>
    ({ id: 'r1', sessionId: 's1', status, cancelRequested: false } as any);

  /** A loop that ends as completed every time it is run; counts the runs of it. */
  function completing(times: { n: number }) {
    return async function* completingLoop(): AsyncGenerator<
      HarnessEvent,
      RunOutcome
    > {
      times.n += 1;
      yield { type: 'run.started', runId: 'r1' };
      const outcome: RunOutcome = { status: 'completed' };
      yield { type: 'run.ended', outcome };
      return outcome;
    };
  }

  it('asks for the check of unread messages only when the model gave its answer', async () => {
    for (const [outcome, requireAllRead] of [
      [{ status: 'completed' }, true],
      [{ status: 'completed', endReason: 'max_steps' }, false],
      [{ status: 'waiting_approval', pending: [] }, false],
      [{ status: 'failed', message: 'm' }, false],
      [{ status: 'cancelled' }, false],
    ] as [RunOutcome, boolean][]) {
      const { supervisor, runs } = setup(() => ending(outcome));
      await supervisor.launch(leased('r1', 'lease-1'), request).done;
      expect(runs.transition.mock.calls[0][2].requireAllRead === true).toBe(
        requireAllRead,
      );
    }
  });

  it('keeps the run when a message is unread: it runs the loop again on the same lease, and the subscribers see one run.started and one run.ended', async () => {
    const times = { n: 0 };
    let refused = 1;
    const { supervisor, runs, execute } = setup(() => completing(times)(), {
      transition: jest.fn(async () => {
        if (refused-- > 0) throw new UnreadMessages('r1');
        return stored('completed');
      }),
      get: jest.fn(async () => ({
        ...stored('running'),
        usage: { stepsUsed: 3, toolCallsUsed: 0, elapsedSeconds: 7 },
      })),
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const seen: HostEvent[] = [];
    for await (const event of handle.events) seen.push(event);

    expect(times.n).toBe(2);
    expect(seen.map(e => e.type)).toEqual(['run.started', 'run.ended']);
    expect(runs.transition).toHaveBeenCalledTimes(2);
    // The second round has the lease of the first and the usage of the run now.
    expect(execute.mock.calls[1][0]).toMatchObject({
      fence: { runId: 'r1', leaseOwner: 'lease-1' },
      usage: { stepsUsed: 3, elapsedSeconds: 7 },
    });
  });

  it('stops asking again after a limit, and ends the run as failed', async () => {
    const { supervisor, runs, logger } = setup(() => completing({ n: 0 })(), {
      transition: jest.fn(async (_id: string, to: string, opts: any) => {
        if (opts.requireAllRead) throw new UnreadMessages('r1');
        return stored(to);
      }),
      get: jest.fn(async () => ({
        ...stored('running'),
        usage: { stepsUsed: 0, toolCallsUsed: 0, elapsedSeconds: 0 },
      })),
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const seen: HostEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    // 1 try and 20 more, then the run fails with a fixed text.
    expect(
      runs.transition.mock.calls.filter((c: any) => c[2].requireAllRead),
    ).toHaveLength(21);
    expect(runs.transition).toHaveBeenLastCalledWith(
      'r1',
      'failed',
      expect.objectContaining({ endReason: 'error' }),
    );
    expect(seen[seen.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'failed', message: 'The run stopped.' },
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls afterRun after the status is written, with the principal of the request, and sends queue.state before run.ended', async () => {
    const order: string[] = [];
    const afterRun = jest.fn(async (info: any) => {
      order.push(`afterRun ${info.run.status} ${info.outcome.status}`);
      return { items: [], paused: false, nextRunId: 'r2' };
    });
    const { supervisor } = setup(
      () => ending({ status: 'completed' }),
      {
        transition: jest.fn(async (_i: string, to: string) => {
          order.push(`transition ${to}`);
          return stored(to);
        }),
      },
      { afterRun },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), withPrincipal);
    const seen: HostEvent[] = [];
    for await (const event of handle.events) {
      order.push(`subscriber ${event.type}`);
      seen.push(event);
    }
    expect(order).toEqual([
      'subscriber run.started',
      'transition completed',
      'afterRun completed completed',
      'subscriber queue.state',
      'subscriber run.ended',
    ]);
    expect(afterRun).toHaveBeenCalledWith({
      run: stored('completed'),
      outcome: { status: 'completed' },
      principal,
    });
    expect(seen[1]).toEqual({
      type: 'queue.state',
      items: [],
      paused: false,
      nextRunId: 'r2',
    });
  });

  it('calls afterRun for a run that waits for an approval, with that outcome', async () => {
    const afterRun = jest.fn(async () => ({ items: [], paused: false }));
    const { supervisor } = setup(
      () => ending({ status: 'waiting_approval', pending: [] }),
      { transition: jest.fn(async (_i: string, to: string) => stored(to)) },
      { afterRun },
    );
    await supervisor.launch(leased('r1', 'lease-1'), withPrincipal).done;
    expect(afterRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'waiting_approval', pending: [] },
      }),
    );
  });

  it('calls afterRun with the outcome the subscribers get: a stop request turns the wait into cancelled', async () => {
    const afterRun = jest.fn(async () => ({ items: [], paused: true }));
    const { supervisor } = setup(
      () => ending({ status: 'waiting_approval', pending: [] }),
      {
        transition: jest.fn(async (_i: string, to: string) => ({
          ...stored(to),
          cancelRequested: to === 'waiting_approval',
        })),
      },
      { afterRun },
    );
    await supervisor.launch(leased('r1', 'lease-1'), withPrincipal).done;
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { status: 'cancelled' } }),
    );
  });

  it('tells the failure of a loop that threw to afterRun as a failed run', async () => {
    const afterRun = jest.fn(async () => ({ items: [], paused: true }));
    const { supervisor } = setup(
      async function* throwingLoop() {
        yield { type: 'run.started', runId: 'r1' };
        throw new Error('database down');
      },
      { transition: jest.fn(async (_i: string, to: string) => stored(to)) },
      { afterRun },
    );
    await supervisor.launch(leased('r1', 'lease-1'), withPrincipal).done;
    expect(afterRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: stored('failed'),
        outcome: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('does not call afterRun for a run it does not own any more, or when the backend shuts down', async () => {
    const afterRun = jest.fn(async () => ({ items: [], paused: false }));
    const lost = setup(
      () => ending({ status: 'completed' }),
      {
        transition: jest.fn(async () => {
          throw new LeaseLost('r1');
        }),
      },
      { afterRun },
    );
    await lost.supervisor.launch(leased('r1', 'lease-1'), withPrincipal).done;
    expect(afterRun).not.toHaveBeenCalled();
  });

  it('ends the run and goes on when afterRun fails: no queue.state, run.ended still comes', async () => {
    const afterRun = jest.fn(async () => {
      throw new Error('queue table gone');
    });
    const { supervisor, logger } = setup(
      () => ending({ status: 'completed' }),
      { transition: jest.fn(async (_i: string, to: string) => stored(to)) },
      { afterRun },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), withPrincipal);
    const types: string[] = [];
    for await (const event of handle.events) types.push(event.type);
    expect(types).toEqual(['run.started', 'run.ended']);
    expect(logger.error).toHaveBeenCalledWith(
      'Could not tell the state of the queue',
      expect.objectContaining({ error: 'queue table gone' }),
    );
  });
});

describe('RunSupervisor activity (B-05)', () => {
  const storedRun = {
    id: 'r1',
    sessionId: 's1',
    cancelRequested: false,
  };

  async function activities(outcome: RunOutcome): Promise<string[]> {
    const seen: string[] = [];
    const { supervisor } = setup(
      () => ending(outcome),
      { transition: jest.fn(async () => storedRun) },
      {
        notify: async (_sessionId, activity) => {
          seen.push(activity);
        },
      },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    for await (const _event of handle.events) {
      // Reads the run to its end.
    }
    await handle.done;
    await new Promise(resolve => setImmediate(resolve));
    return seen;
  }

  it('tells the notifier when a run starts, waits, completes, or ends without a reply', async () => {
    expect(await activities({ status: 'completed' })).toEqual([
      'running',
      'replied',
    ]);
    expect(
      await activities({ status: 'waiting_approval', pending: [] }),
    ).toEqual(['running', 'waiting_approval']);
    expect(
      await activities({ status: 'failed', message: 'The run stopped.' }),
    ).toEqual(['running', 'idle']);
    expect(await activities({ status: 'cancelled' })).toEqual([
      'running',
      'idle',
    ]);

    const notify = jest.fn(async () => {});
    const expired = setup(
      (_fence, signal) => blocked(signal),
      {
        transition: jest.fn(async () => storedRun),
      },
      { notify },
    );
    const expiring = expired.supervisor.launch(
      leased('r1', 'lease-1'),
      request,
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(notify).toHaveBeenCalledWith('s1', 'running');
    await expired.supervisor.shutdown(10);
    await expiring.done;
    await new Promise(resolve => setImmediate(resolve));
    expect(notify).toHaveBeenCalledWith('s1', 'idle');

    const failing = jest.fn(async () => {
      throw new Error('signals down');
    });
    const { supervisor, logger } = setup(
      () => ending({ status: 'completed' }),
      { transition: jest.fn(async () => storedRun) },
      { notify: failing },
    );
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    for await (const _event of handle.events) {
      // The run ends even though the notifier throws.
    }
    await expect(handle.done).resolves.toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not notify the activity of a session',
      expect.objectContaining({ sessionId: 's1' }),
    );
  });

  it('keeps the text of the open agent message until that item is stored', async () => {
    let releaseDraft!: () => void;
    let releaseEnd!: () => void;
    const draftOpen = new Promise<void>(resolve => (releaseDraft = resolve));
    const endOpen = new Promise<void>(resolve => (releaseEnd = resolve));
    let stage = 0;
    const { supervisor } = setup(async function* openDraftLoop() {
      yield { type: 'run.started', runId: 'r1' };
      yield { type: 'item.started', draftId: 'd1', kind: 'agent_message' };
      yield { type: 'item.delta', draftId: 'd1', text: 'Hel' };
      stage = 1;
      await draftOpen;
      yield {
        type: 'item.completed',
        draftId: 'd1',
        item: { kind: 'agent_message', text: 'Hello', seq: 2 } as any,
      };
      stage = 2;
      await endOpen;
      const outcome: RunOutcome = { status: 'completed' };
      yield { type: 'run.ended', outcome };
      return outcome;
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stage).toBe(1);
    expect(supervisor.openDraft('r1')).toEqual({
      draftId: 'd1',
      text: 'Hel',
      emittedSeq: 0,
    });
    releaseDraft();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stage).toBe(2);
    expect(supervisor.openDraft('r1')).toBeUndefined();
    releaseEnd();
    await handle.done;
    expect(supervisor.openDraft('r1')).toBeUndefined();
  });
});

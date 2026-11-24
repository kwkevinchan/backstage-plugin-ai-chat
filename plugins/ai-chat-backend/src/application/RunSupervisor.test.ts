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
import type { LeasedRun } from '../domain';
import { RunSupervisor, type LaunchRequest } from './RunSupervisor';
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
  const advance = {
    execute: (req: any) => loop(req.fence, req.signal),
  } as unknown as Pick<AdvanceRun, 'execute'>;
  const supervisor = new RunSupervisor({
    advance,
    runs,
    logger,
    heartbeatMs: 10,
  });
  return { supervisor, runs: runs as any, logger, calls };
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

  it('logs the cause of a failure and of a failed summary, and keeps it from the subscribers', async () => {
    const { supervisor, logger } = setup(async function* () {
      yield { type: 'summary.failed', cause: new Error('provider said x') };
      const outcome: RunOutcome = {
        status: 'failed',
        message: 'The model call failed.',
        cause: new Error('provider said y'),
      };
      yield { type: 'run.ended', outcome };
      return outcome;
    });
    const handle = supervisor.launch(leased('r1', 'lease-1'), request);
    const seen: HarnessEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(logger.warn).toHaveBeenCalledWith(
      'A summary could not be made',
      expect.objectContaining({ cause: 'provider said x' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'A run failed',
      expect.objectContaining({ cause: 'provider said y' }),
    );
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
    const seen: HarnessEvent[] = [];
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
});

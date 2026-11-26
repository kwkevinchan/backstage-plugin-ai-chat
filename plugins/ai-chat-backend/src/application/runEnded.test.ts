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

import type { RunSummary } from '@kwkevinchan/ai-chat-harness';
import type { Run } from '../domain';
import { createRunEnded } from './runEnded';

const run: Run = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'completed',
  endReason: 'max_steps',
  usage: { stepsUsed: 3, toolCallsUsed: 2, elapsedSeconds: 4 },
  cancelRequested: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:04.000Z',
};

const fakeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

/** Waits until `condition` holds, or fails after two seconds. */
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

describe('createRunEnded', () => {
  it('gives each hook the stored status, end reason and usage, and the user ref', async () => {
    const seen: RunSummary[] = [];
    const runEnded = createRunEnded({
      hooks: [s => void seen.push(s), s => void seen.push(s)],
      logger: fakeLogger(),
    });
    runEnded({ run, agentId: 'guide', userRef: 'user:default/jane' });
    await until(() => seen.length === 2);
    expect(seen[0]).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'guide',
      userRef: 'user:default/jane',
      status: 'completed',
      endReason: 'max_steps',
      usage: { stepsUsed: 3, toolCallsUsed: 2, elapsedSeconds: 4 },
    });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('returns before the hooks finish', () => {
    const seen: string[] = [];
    const runEnded = createRunEnded({
      hooks: [async () => void seen.push('hook')],
      logger: fakeLogger(),
    });
    runEnded({ run, agentId: 'guide', userRef: 'user:default/jane' });
    seen.push('returned');
    expect(seen[0]).toBe('returned');
  });

  it('ignores a run that waits for an approval or still runs', async () => {
    const hook = jest.fn();
    const runEnded = createRunEnded({
      hooks: [hook],
      logger: fakeLogger(),
    });
    runEnded({
      run: { ...run, status: 'waiting_approval' },
      agentId: 'guide',
      userRef: 'user:default/jane',
    });
    runEnded({
      run: { ...run, status: 'running' },
      agentId: 'guide',
      userRef: 'user:default/jane',
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(hook).not.toHaveBeenCalled();
  });

  it('runs the next hook after one that throws, and after one that does not finish in time', async () => {
    const logger = fakeLogger();
    const seen: string[] = [];
    const runEnded = createRunEnded({
      hooks: [
        () => {
          throw new Error('sink down');
        },
        async () => {
          throw new Error('sink down');
        },
        () => new Promise<void>(() => undefined),
        () => void seen.push('last'),
      ],
      logger,
      timeoutMs: 20,
    });
    runEnded({ run, agentId: 'guide', userRef: 'user:default/jane' });
    await until(() => seen.length === 1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'An onRunEnd hook did not finish in 20 ms; the next one runs',
      { runId: 'run-1' },
    );
  });

  it('drains: waits for a hook that is slow, and stops waiting after the limit', async () => {
    let slowDone = false;
    const slow = createRunEnded({
      hooks: [
        async () => {
          await new Promise(resolve => setTimeout(resolve, 30));
          slowDone = true;
        },
      ],
      logger: fakeLogger(),
    });
    slow({ run, agentId: 'guide', userRef: 'user:default/jane' });
    await slow.drain(1000);
    expect(slowDone).toBe(true);

    const hanging = createRunEnded({
      hooks: [() => new Promise<void>(() => undefined)],
      logger: fakeLogger(),
    });
    hanging({ run, agentId: 'guide', userRef: 'user:default/jane' });
    const started = Date.now();
    await hanging.drain(20);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('drains at once when no hook runs', async () => {
    const runEnded = createRunEnded({ hooks: [], logger: fakeLogger() });
    await expect(runEnded.drain(10_000)).resolves.toBeUndefined();
  });

  it('measures every run that ends, also without hooks, and not one that waits (O-01)', () => {
    const measured: unknown[] = [];
    const runEnded = createRunEnded({
      hooks: [],
      logger: fakeLogger(),
      telemetry: { runEnded: r => void measured.push(r) },
    });
    runEnded({ run, agentId: 'guide', userRef: 'user:default/jane' });
    runEnded({
      run: { ...run, id: 'run-2', status: 'waiting_approval' },
      agentId: 'guide',
      userRef: 'user:default/jane',
    });
    expect(measured).toEqual([
      {
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'guide',
        status: 'completed',
        endReason: 'max_steps',
        usage: { stepsUsed: 3, toolCallsUsed: 2, elapsedSeconds: 4 },
      },
    ]);
  });
});

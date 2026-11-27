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

import type { RunOutcome } from '@kwkevinchan/ai-chat-harness';
import { FakeClock } from '@kwkevinchan/ai-chat-harness/testing';
import {
  TooManyActiveRuns,
  type Principal,
  type QueuedMessage,
  type Run,
} from '../domain';
import { createAfterRun } from './afterRun';

// The rules of IN-14 to IN-16 against fakes: which outcome and which
// credentials let the queue send its next message. The database and the real
// start are in `src/integration`.

const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
const settings = {
  limits: {
    maxSteps: 10,
    maxToolCallsPerRun: 30,
    runTimeoutSeconds: 300,
    maxToolCallsPerStep: 8,
    readConcurrency: 4,
    toolTimeoutSeconds: 60,
  },
  budget: { tokenBudget: 1000, keepRecentSteps: 6 },
};
const message = (id: string): QueuedMessage => ({
  id,
  sessionId: 's1',
  position: 1,
  text: id,
  attachments: [],
  createdAt: 'x',
  updatedAt: 'x',
});
const run = { id: 'r1', sessionId: 's1', status: 'completed' } as Run;
const principalWith = (credentialsExpireAt?: string): Principal => ({
  userRef: 'user:default/jane',
  ownershipRefs: [],
  credentials: {},
  ...(credentialsExpireAt && { credentialsExpireAt }),
});
// 300 seconds of the run and 30 of margin, to the second.
const ENOUGH = '2026-01-01T00:05:30.000Z';
const TOO_SHORT = '2026-01-01T00:05:29.000Z';

function setup(options: { items?: QueuedMessage[]; accepting?: boolean } = {}) {
  const items = options.items ?? [message('a'), message('b')];
  const queue = { list: jest.fn(async () => items) };
  const events = { return: jest.fn(async () => ({ done: true })) };
  const startNext = {
    execute: jest.fn(
      async (): Promise<any> => ({
        run: {
          runId: 'r2',
          events: { [Symbol.asyncIterator]: () => events },
        },
        message: message('a'),
      }),
    ),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const afterRun = createAfterRun({
    queue: queue as any,
    startNext: startNext as any,
    supervisor: { accepting: options.accepting ?? true },
    clock,
    settings,
    logger,
  });
  return { afterRun, queue, startNext, logger, events, items };
}

const outcomeOf = (outcome: RunOutcome) => outcome;

describe('afterRun', () => {
  it('starts the next run after a normal end and tells the queue with the id of the run', async () => {
    const t = setup();
    const state = await t.afterRun({
      run,
      outcome: outcomeOf({ status: 'completed' }),
      principal: principalWith(ENOUGH),
    });
    expect(t.startNext.execute).toHaveBeenCalledWith({
      principal: principalWith(ENOUGH),
      sessionId: 's1',
    });
    expect(state).toEqual({ items: t.items, paused: false, nextRunId: 'r2' });
    // Nobody reads the events of the new run here: the subscription is freed.
    expect(t.events.return).toHaveBeenCalled();
  });

  it('does not send while the run only waits for an approval, and the queue is not paused (the first rule)', async () => {
    const t = setup();
    const state = await t.afterRun({
      run: { ...run, status: 'waiting_approval' } as Run,
      outcome: { status: 'waiting_approval', pending: [] },
      principal: principalWith(ENOUGH),
    });
    expect(t.startNext.execute).not.toHaveBeenCalled();
    expect(state).toEqual({ items: t.items, paused: false });
  });

  it('is not paused and starts nothing when the queue is empty', async () => {
    const t = setup({ items: [] });
    const state = await t.afterRun({
      run,
      outcome: { status: 'completed' },
      principal: principalWith(ENOUGH),
    });
    expect(t.startNext.execute).not.toHaveBeenCalled();
    expect(state).toEqual({ items: [], paused: false });
  });

  it.each([
    ['failed', { status: 'failed' as const, message: 'm' }],
    ['cancelled', { status: 'cancelled' as const }],
    [
      'completed with a limit',
      { status: 'completed' as const, endReason: 'max_steps' as const },
    ],
    [
      'completed with the timeout',
      { status: 'completed' as const, endReason: 'timeout' as const },
    ],
  ])('pauses the queue when the run is %s', async (_name, outcome) => {
    const t = setup();
    const state = await t.afterRun({
      run,
      outcome,
      principal: principalWith(ENOUGH),
    });
    expect(t.startNext.execute).not.toHaveBeenCalled();
    expect(state).toEqual({
      items: t.items,
      paused: true,
      pausedReason: 'run_not_completed',
    });
  });

  it('pauses the queue when the credentials have less than the working time of a run and the margin left, or no known end (IN-16)', async () => {
    for (const expires of [TOO_SHORT, undefined, 'not a date']) {
      const t = setup();
      const state = await t.afterRun({
        run,
        outcome: { status: 'completed' },
        principal: principalWith(expires),
      });
      expect(t.startNext.execute).not.toHaveBeenCalled();
      expect(state).toEqual({
        items: t.items,
        paused: true,
        pausedReason: 'credentials',
      });
    }
  });

  it('starts when the credentials last exactly as long as the run and the margin need', async () => {
    const t = setup();
    await t.afterRun({
      run,
      outcome: { status: 'completed' },
      principal: principalWith(ENOUGH),
    });
    expect(t.startNext.execute).toHaveBeenCalledTimes(1);
  });

  it('pauses the queue when this backend is shutting down', async () => {
    const t = setup({ accepting: false });
    const state = await t.afterRun({
      run,
      outcome: { status: 'completed' },
      principal: principalWith(ENOUGH),
    });
    expect(t.startNext.execute).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      paused: true,
      pausedReason: 'shutting_down',
    });
  });

  it('is not paused when nothing started because the queue was emptied or a run began first', async () => {
    const t = setup();
    t.startNext.execute.mockResolvedValue(undefined);
    const state = await t.afterRun({
      run,
      outcome: { status: 'completed' },
      principal: principalWith(ENOUGH),
    });
    expect(state).toEqual({ items: t.items, paused: false });
  });

  it('pauses the queue without a log when the user has as many runs as allowed (P-05)', async () => {
    const t = setup();
    t.startNext.execute.mockRejectedValue(new TooManyActiveRuns(3));
    const state = await t.afterRun({
      run,
      outcome: { status: 'completed' },
      principal: principalWith(ENOUGH),
    });
    expect(state).toEqual({ items: t.items, paused: true });
    expect(t.logger.error).not.toHaveBeenCalled();
  });

  it('logs an error of the start and counts it as a pause', async () => {
    const t = setup();
    t.startNext.execute.mockRejectedValue(new Error('audit down'));
    const state = await t.afterRun({
      run,
      outcome: { status: 'completed' },
      principal: principalWith(ENOUGH),
    });
    expect(state).toEqual({ items: t.items, paused: true });
    expect(t.logger.error).toHaveBeenCalledWith(
      'The queue could not send its next message',
      expect.objectContaining({ sessionId: 's1', errorName: 'Error' }),
    );
    expect(JSON.stringify(t.logger.error.mock.calls)).not.toContain(
      'audit down',
    );
  });
});

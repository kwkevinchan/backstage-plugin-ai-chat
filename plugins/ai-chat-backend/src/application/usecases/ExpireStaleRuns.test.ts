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

import type { Run } from '../../domain';
import type { RunRepository } from '../ports';
import type { RunEnded } from '../runEnded';
import { ExpireStaleRuns } from './ExpireStaleRuns';

const runOf = (id: string, sessionId: string): Run => ({
  id,
  sessionId,
  status: 'expired',
  endReason: 'lease_expired',
  usage: { stepsUsed: 1, toolCallsUsed: 0, elapsedSeconds: 2 },
  cancelRequested: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:01:00.000Z',
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

describe('ExpireStaleRuns', () => {
  it('tells the onRunEnd hooks about each expired run, and skips one whose session cannot be read', async () => {
    const runs = {
      expireStale: async () => ['run-1', 'run-2'],
      get: async (id: string) =>
        runOf(id, id === 'run-1' ? 'session-1' : 'session-gone'),
    } as unknown as RunRepository;
    const sessions = {
      get: async (id: string) => {
        if (id === 'session-gone') throw new Error('no such session');
        return { id, agentId: 'guide', ownerRef: 'user:default/jane' };
      },
    } as never;
    const ended: Parameters<RunEnded>[0][] = [];
    const runEnded = Object.assign(
      (info: Parameters<RunEnded>[0]) => void ended.push(info),
      { drain: async () => undefined },
    );
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const ids = await new ExpireStaleRuns({
      runs,
      logger,
      sessions,
      runEnded,
    }).execute();

    expect(ids).toEqual(['run-1', 'run-2']);
    await until(() => logger.warn.mock.calls.length === 2);
    expect(ended).toEqual([
      {
        run: runOf('run-1', 'session-1'),
        agentId: 'guide',
        userRef: 'user:default/jane',
      },
    ]);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'Could not tell the onRunEnd hooks about an expired run',
      { runId: 'run-2', error: 'no such session' },
    );
  });
});

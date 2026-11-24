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

import { itemLogContract, InMemoryItemLog } from '.';

itemLogContract('InMemoryItemLog', async () => {
  const log = new InMemoryItemLog();
  let count = 0;
  return {
    subject: {
      log,
      newSession: async () => {
        count += 1;
        const sessionId = `session-${count}`;
        const fence = { runId: `run-${count}`, leaseOwner: 'backend-a' };
        log.grantLease(sessionId, fence);
        return {
          sessionId,
          fence,
          staleFence: { runId: fence.runId, leaseOwner: 'backend-b' },
        };
      },
    },
  };
});

describe('InMemoryItemLog', () => {
  it('refuses a write of a run that has no lease', async () => {
    const log = new InMemoryItemLog();
    await expect(
      log.append('s', [{ kind: 'user_message', text: 'a' }], {
        runId: 'run-9',
        leaseOwner: 'x',
      }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('moves the lease to the owner that is granted it last', async () => {
    const log = new InMemoryItemLog();
    const a = { runId: 'run-1', leaseOwner: 'a' };
    const b = { runId: 'run-1', leaseOwner: 'b' };
    log.grantLease('s', a);
    log.grantLease('s', b);
    await expect(
      log.append('s', [{ kind: 'user_message', text: 'x' }], a),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(
      log.append('s', [{ kind: 'user_message', text: 'x' }], b),
    ).resolves.toHaveLength(1);
  });
});

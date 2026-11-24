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

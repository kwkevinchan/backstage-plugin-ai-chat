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
import { callsAwaitingDecision, findToolCall, hasResult } from './approval';

let seq = 0;
const base = (runId = 'r1') => ({
  sessionId: 's',
  seq: ++seq,
  runId,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const call = (
  callId: string,
  extra: { policy?: 'allow' | 'ask'; readOnly?: boolean; runId?: string } = {},
) =>
  ({
    ...base(extra.runId),
    kind: 'tool_call',
    callId,
    toolId: 'a:b',
    input: {},
    schemaHash: 'h',
    policy: extra.policy ?? 'ask',
    readOnly: extra.readOnly ?? false,
    step: 1,
    position: 0,
  } as Item);
const approval = (callId: string) =>
  ({
    ...base(),
    kind: 'approval',
    callId,
    decision: 'allow',
    decidedBy: 'u',
  } as Item);
const result = (callId: string) =>
  ({ ...base(), kind: 'tool_result', callId, status: 'ok' } as Item);

describe('callsAwaitingDecision', () => {
  it('lists the calls that need approval and have no decision and no result', () => {
    const items = [call('c1'), call('c2'), call('c3'), approval('c2')];
    expect(callsAwaitingDecision(items, 'r1').map(c => c.callId)).toEqual([
      'c1',
      'c3',
    ]);
  });

  it('uses the rule of the core: a call that is not read-only asks whatever its policy says', () => {
    const items = [
      call('c1', { policy: 'allow', readOnly: false }),
      call('c2', { policy: 'allow', readOnly: true }),
      call('c3', { policy: 'ask', readOnly: true }),
    ];
    expect(callsAwaitingDecision(items, 'r1').map(c => c.callId)).toEqual([
      'c1',
      'c3',
    ]);
  });

  it('leaves out a call that has a result, and the calls of another run', () => {
    const items = [call('c1'), result('c1'), call('c2', { runId: 'r2' })];
    expect(callsAwaitingDecision(items, 'r1')).toEqual([]);
  });
});

describe('findToolCall and hasResult', () => {
  it('find a call and its result by id', () => {
    const items = [call('c1'), result('c1')];
    expect(findToolCall(items, 'c1')?.callId).toBe('c1');
    expect(findToolCall(items, 'x')).toBeUndefined();
    expect(hasResult(items, 'c1')).toBe(true);
    expect(hasResult(items, 'c2')).toBe(false);
  });
});

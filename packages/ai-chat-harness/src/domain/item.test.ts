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

import { dedupeKeyOf } from './item';
import {
  approve,
  call,
  log,
  note,
  result,
  started,
  summary,
  user,
} from './fixtures';
import { currentPlan } from './plan';

describe('dedupeKeyOf (T-07, D-25)', () => {
  it.each([
    ['approval', approve('c1'), 'approval:c1'],
    ['tool_started', started('c1'), 'tool_started:c1'],
    ['tool_result', result('c1'), 'tool_result:c1'],
    ['user_message', user(), undefined],
    ['tool_call', call('c1'), 'tool_call:c1'],
    ['note', note(), undefined],
    ['summary', summary(3), undefined],
  ])('%s', (_kind, body, expected) => {
    expect(dedupeKeyOf(body)).toBe(expected);
  });

  it('is the same for two calls with the same id, so the log refuses the second', () => {
    expect(dedupeKeyOf(call('c1', { toolId: 'a:one' }))).toBe(
      dedupeKeyOf(call('c1', { toolId: 'a:two', policy: 'ask' })),
    );
  });

  it('differs between the kinds and between the calls', () => {
    const keys = [
      approve('c1'),
      approve('c2'),
      started('c1'),
      result('c1'),
    ].map(dedupeKeyOf);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('currentPlan', () => {
  const plan = (text: string) => ({
    kind: 'plan_update' as const,
    plan: { items: [{ text, status: 'pending' as const }] },
  });

  it('is the plan of the last plan_update', () => {
    expect(
      currentPlan(log(user(), plan('first'), user(), plan('second'))),
    ).toEqual({
      items: [{ text: 'second', status: 'pending' }],
    });
  });

  it('is undefined without a plan_update', () => {
    expect(currentPlan(log(user()))).toBeUndefined();
    expect(currentPlan([])).toBeUndefined();
  });
});

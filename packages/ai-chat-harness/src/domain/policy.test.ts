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
  decidePolicy,
  needsApproval,
  PolicyName,
  PolicySettings,
} from './policy';
import { tool } from './fixtures';

describe('decidePolicy', () => {
  // [rule, tool flags, setting for the tool, result]
  it.each<
    [
      string,
      { readOnly: boolean; egress?: boolean },
      PolicyName | undefined,
      PolicyName,
    ]
  >([
    ['read-only, no setting: allow', { readOnly: true }, undefined, 'allow'],
    ['read-only, set to allow: allow', { readOnly: true }, 'allow', 'allow'],
    ['read-only, set to ask: ask', { readOnly: true }, 'ask', 'ask'],
    ['read-only, set to deny: deny', { readOnly: true }, 'deny', 'deny'],
    ['not read-only, no setting: ask', { readOnly: false }, undefined, 'ask'],
    [
      'not read-only, set to allow: still ask (D-06, T-03)',
      { readOnly: false },
      'allow',
      'ask',
    ],
    ['not read-only, set to ask: ask', { readOnly: false }, 'ask', 'ask'],
    ['not read-only, set to deny: deny', { readOnly: false }, 'deny', 'deny'],
    [
      'egress and read-only, no setting: ask (T-04)',
      { readOnly: true, egress: true },
      undefined,
      'ask',
    ],
    [
      'egress and read-only, set to allow: still ask (T-04)',
      { readOnly: true, egress: true },
      'allow',
      'ask',
    ],
    [
      'egress and read-only, set to deny: deny',
      { readOnly: true, egress: true },
      'deny',
      'deny',
    ],
    [
      'egress and not read-only, set to allow: ask',
      { readOnly: false, egress: true },
      'allow',
      'ask',
    ],
    [
      'egress false does not change a read-only tool: allow',
      { readOnly: true, egress: false },
      'allow',
      'allow',
    ],
  ])('%s', (_rule, flags, configured, expected) => {
    const descriptor = tool({ id: 'temporal:start-workflow', ...flags });
    const settings: PolicySettings = configured
      ? { byTool: { 'temporal:start-workflow': configured } }
      : {};
    expect(decidePolicy(descriptor, settings)).toBe(expected);
  });

  it('ignores the setting of another tool', () => {
    expect(
      decidePolicy(tool({ id: 'a:one' }), { byTool: { 'a:two': 'deny' } }),
    ).toBe('allow');
  });

  it.each([['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty']])(
    'does not read %s from the prototype of the settings',
    toolId => {
      expect(decidePolicy(tool({ id: toolId }), { byTool: {} })).toBe('allow');
    },
  );

  it('treats a tool without a readOnly flag as not read-only', () => {
    const descriptor = { ...tool(), readOnly: undefined } as never;
    expect(decidePolicy(descriptor, {})).toBe('ask');
    expect(
      decidePolicy(descriptor, { byTool: { 'catalog:get-entity': 'allow' } }),
    ).toBe('ask');
  });

  it('asks for a setting it does not know, even for a read-only tool', () => {
    const settings = { byTool: { 'catalog:get-entity': 'yes' } } as never;
    expect(decidePolicy(tool(), settings)).toBe('ask');
  });
});

describe('needsApproval', () => {
  it.each<[string, 'allow' | 'ask', boolean | undefined, boolean]>([
    ['allow and read-only: no', 'allow', true, false],
    ['ask and read-only: yes', 'ask', true, true],
    ['allow and not read-only: yes', 'allow', false, true],
    ['ask and not read-only: yes', 'ask', false, true],
    ['allow and no readOnly flag: yes', 'allow', undefined, true],
  ])('%s', (_rule, policy, readOnly, expected) => {
    expect(needsApproval({ policy, readOnly: readOnly as boolean })).toBe(
      expected,
    );
  });
});

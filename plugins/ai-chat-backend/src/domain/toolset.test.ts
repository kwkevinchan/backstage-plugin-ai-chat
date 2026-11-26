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

import type { ToolDescriptor } from '@kwkevinchan/ai-chat-harness';
import {
  defaultToolsetIds,
  enabledTools,
  isEgress,
  matchesActionPattern,
  offeredToolsetIds,
  unsafeAllows,
  type Toolset,
} from './toolset';

const tool = (id: string, readOnly = true): ToolDescriptor => ({
  id,
  description: id,
  inputSchema: { type: 'object' },
  schemaHash: 'h',
  readOnly,
});

const toolset = (id: string, extra: Partial<Toolset> = {}): Toolset => ({
  id,
  actions: [`${id}:*`],
  exclude: [],
  default: false,
  egress: false,
  ...extra,
});

describe('matchesActionPattern', () => {
  it.each([
    ['catalog:*', 'catalog:get-entity', true],
    ['catalog:*', 'scaffolder:run', false],
    ['*', 'a:b', true],
    ['catalog:get-entity', 'catalog:get-entity', true],
    ['catalog:get-entity', 'catalog:get-entity-2', false],
    ['a.b:*', 'axb:c', false],
  ])('%s against %s is %s', (pattern, id, expected) => {
    expect(matchesActionPattern(pattern, id)).toBe(expected);
  });
});

describe('enabledTools', () => {
  const tools = [
    tool('catalog:get'),
    tool('web:fetch'),
    tool('other:x'),
    tool('catalog:delete', false),
  ];
  const toolsets = [toolset('catalog'), toolset('web')];

  it('offers only the tools of the toolsets the session switched on (T-02)', () => {
    expect(enabledTools(tools, toolsets, ['catalog']).map(t => t.id)).toEqual([
      'catalog:get',
      'catalog:delete',
    ]);
  });

  it('offers nothing when the session switched nothing on', () => {
    expect(enabledTools(tools, toolsets, [])).toEqual([]);
  });

  it('never offers a tool that is in no toolset (T-01)', () => {
    const ids = enabledTools(tools, toolsets, ['catalog', 'web']).map(
      t => t.id,
    );
    expect(ids).not.toContain('other:x');
  });

  it('ignores a toolset id that the administrator did not define (T-11)', () => {
    expect(enabledTools(tools, toolsets, ['unknown', 'other'])).toEqual([]);
  });

  it('leaves out a tool that a toolset excludes', () => {
    const narrowed = [toolset('catalog', { exclude: ['catalog:delete'] })];
    expect(enabledTools(tools, narrowed, ['catalog']).map(t => t.id)).toEqual([
      'catalog:get',
    ]);
  });
});

describe('isEgress', () => {
  const toolsets = [toolset('web', { egress: true }), toolset('catalog')];

  it('is true for a tool in an egress toolset (T-04)', () => {
    expect(isEgress('web:fetch', toolsets)).toBe(true);
  });

  it('is false for a tool in other toolsets and for one in none', () => {
    expect(isEgress('catalog:get', toolsets)).toBe(false);
    expect(isEgress('other:x', toolsets)).toBe(false);
  });

  it('is true when one of several toolsets sends data out', () => {
    const both = [
      toolset('a', { actions: ['x:*'] }),
      toolset('b', { actions: ['x:*'], egress: true }),
    ];
    expect(isEgress('x:y', both)).toBe(true);
  });
});

describe('defaultToolsetIds', () => {
  it('lists the toolsets that are on by default (D-24)', () => {
    expect(
      defaultToolsetIds([
        toolset('a', { default: true }),
        toolset('b'),
        toolset('c', { default: true }),
      ]),
    ).toEqual(['a', 'c']);
  });
});

describe('unsafeAllows', () => {
  it('lists the tools that are not read-only and set to allow (D-06)', () => {
    const tools = [
      tool('a:write', false),
      tool('a:read'),
      tool('a:other', false),
    ];
    expect(
      unsafeAllows(tools, {
        byTool: { 'a:write': 'allow', 'a:read': 'allow', 'a:other': 'ask' },
      }),
    ).toEqual(['a:write']);
  });

  it('lists a read-only tool of an egress toolset that is set to allow', () => {
    const web = { ...tool('web:fetch'), egress: true };
    expect(unsafeAllows([web], { byTool: { 'web:fetch': 'allow' } })).toEqual([
      'web:fetch',
    ]);
  });

  it('is empty without settings', () => {
    expect(unsafeAllows([tool('a:write', false)], {})).toEqual([]);
  });
});

describe('offeredToolsetIds (T-08, X-01)', () => {
  it('keeps the toolsets of the session that the user may use', () => {
    expect(offeredToolsetIds(['a', 'b', 'c'], undefined, ['c', 'a'])).toEqual([
      'a',
      'c',
    ]);
  });

  it('keeps only the toolsets the agent names, when it names any', () => {
    expect(offeredToolsetIds(['a', 'b'], ['b'], ['a', 'b'])).toEqual(['b']);
    expect(offeredToolsetIds(['a', 'b'], [], ['a', 'b'])).toEqual([]);
  });

  it('never adds a toolset the session did not switch on', () => {
    expect(offeredToolsetIds(['a'], ['a', 'b'], ['a', 'b'])).toEqual(['a']);
  });
});

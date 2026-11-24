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

import { mockCredentials } from '@backstage/backend-test-utils';
import { FakeActions } from '../__testUtils__';
import {
  assignToolNames,
  isActionOffered,
  matchesPattern,
  ToolCatalog,
} from './ToolCatalog';

describe('matchesPattern', () => {
  it('matches the whole ID, and * stands for any characters', () => {
    expect(matchesPattern('catalog:*', 'catalog:get-entity')).toBe(true);
    expect(matchesPattern('*:get-*', 'catalog:get-entity')).toBe(true);
    expect(matchesPattern('catalog:get', 'catalog:get-entity')).toBe(false);
    expect(matchesPattern('catalog:get-entity', 'catalog:get-entity')).toBe(
      true,
    );
  });

  it('takes every other character as it is', () => {
    expect(matchesPattern('a.b', 'aXb')).toBe(false);
    expect(matchesPattern('a.b', 'a.b')).toBe(true);
    expect(matchesPattern('(x)', '(x)')).toBe(true);
  });
});

describe('isActionOffered', () => {
  it('lets exclude win over include', () => {
    const filter = { include: ['catalog:*'], exclude: ['*:register-*'] };
    expect(isActionOffered('catalog:get-entity', filter)).toBe(true);
    expect(isActionOffered('catalog:register-entity', filter)).toBe(false);
    expect(isActionOffered('temporal:list', filter)).toBe(false);
  });

  it('offers everything without rules', () => {
    expect(isActionOffered('a:b', { include: [], exclude: [] })).toBe(true);
  });
});

describe('assignToolNames', () => {
  it('replaces the characters that the model API refuses', () => {
    const names = assignToolNames(['catalog:get-entity', 'a.b/c:d e']);
    expect(names.get('catalog:get-entity')).toBe('catalog_get-entity');
    expect(names.get('a.b/c:d e')).toBe('a_b_c_d_e');
  });

  it('makes names unique', () => {
    const names = assignToolNames(['a:b', 'a_b', 'a.b']);
    const values = [...names.values()];
    expect(new Set(values).size).toBe(3);
    for (const name of values) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('keeps names within 64 characters, also after the suffix', () => {
    const long = `plugin:${'x'.repeat(100)}`;
    const names = assignToolNames([long, `${long}y`]);
    for (const name of names.values()) {
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(names.values()).size).toBe(2);
  });
});

describe('ToolCatalog', () => {
  it('maps a name of the model back to its action', async () => {
    const actions = new FakeActions([
      { id: 'catalog:get-entity', readOnly: true },
      { id: 'catalog:register-entity' },
    ]);
    const catalog = await ToolCatalog.load(actions, mockCredentials.user(), {
      include: [],
      exclude: [],
    });
    expect(catalog.resolve('catalog_get-entity')?.id).toBe(
      'catalog:get-entity',
    );
    expect(catalog.resolve('catalog:get-entity')).toBeUndefined();
    expect(catalog.resolve('unknown')).toBeUndefined();
    const tools = catalog.tools();
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'catalog_get-entity',
        description: 'catalog:get-entity: The action catalog:get-entity',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    });
  });
});

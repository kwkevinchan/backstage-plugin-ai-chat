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

import { normalizeEntityRef } from './entity';

describe('normalizeEntityRef (SE-02)', () => {
  it.each([
    ['component:default/shop', 'component:default/shop'],
    ['component:shop', 'component:default/shop'],
    ['Component:Default/Shop', 'component:default/shop'],
    ['  group:team-a/platform ', 'group:team-a/platform'],
  ])('writes %s as %s', (value, expected) => {
    expect(normalizeEntityRef(value)).toBe(expected);
  });

  it.each([['shop'], ['default/shop'], [''], ['a:b:c'], ['component:a/b/c']])(
    'has no ref for %j',
    value => {
      expect(normalizeEntityRef(value)).toBeUndefined();
    },
  );
});

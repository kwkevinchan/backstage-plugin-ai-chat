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

import { completedCount, planOfInput } from './plan';

describe('planOfInput', () => {
  it('reads the steps of a plan', () => {
    expect(
      planOfInput({
        items: [
          { text: 'a', status: 'pending' },
          { text: 'b', status: 'completed' },
        ],
      }),
    ).toEqual({
      items: [
        { text: 'a', status: 'pending' },
        { text: 'b', status: 'completed' },
      ],
    });
    expect(planOfInput({ items: [] })).toEqual({ items: [] });
  });

  it.each([
    ['nothing', undefined],
    ['an input still streaming', {}],
    ['items that are not an array', { items: 'a' }],
    ['a step that is not an object', { items: ['a'] }],
    ['a step without text', { items: [{ status: 'pending' }] }],
    ['an unknown status', { items: [{ text: 'a', status: 'done' }] }],
  ])('is undefined for %s', (_name, input) => {
    expect(planOfInput(input)).toBeUndefined();
  });

  it('counts the completed steps', () => {
    expect(
      completedCount({
        items: [
          { text: 'a', status: 'completed' },
          { text: 'b', status: 'in_progress' },
          { text: 'c', status: 'completed' },
        ],
      }),
    ).toBe(2);
  });
});

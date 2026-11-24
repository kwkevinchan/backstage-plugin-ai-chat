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
  DuplicateItem,
  HarnessError,
  InvalidRunTransition,
  LeaseLost,
} from './errors';

describe('errors', () => {
  it.each([
    [
      new InvalidRunTransition('completed', 'running'),
      'INVALID_RUN_TRANSITION',
    ],
    [new DuplicateItem('approval:c1'), 'DUPLICATE_ITEM'],
    [new LeaseLost('run-1'), 'LEASE_LOST'],
  ])('%s has a code and its own name', (error, code) => {
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
  });
});

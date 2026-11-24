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

import { InvalidRunTransition } from './errors';
import {
  assertTransition,
  canTransition,
  isActiveStatus,
  RunStatus,
} from './run';

const all: RunStatus[] = [
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'expired',
];

describe('run status', () => {
  it.each<[RunStatus, RunStatus, boolean]>([
    ['running', 'waiting_approval', true],
    ['running', 'completed', true],
    ['running', 'failed', true],
    ['running', 'cancelled', true],
    ['running', 'expired', true],
    ['waiting_approval', 'running', true],
    ['waiting_approval', 'cancelled', true],
    ['waiting_approval', 'expired', true],
    ['waiting_approval', 'failed', true],
    ['waiting_approval', 'completed', false],
    ['running', 'running', false],
  ])('%s to %s: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it.each(['completed', 'failed', 'cancelled', 'expired'] as RunStatus[])(
    '%s is final',
    from => {
      for (const to of all) {
        expect(canTransition(from, to)).toBe(false);
      }
    },
  );

  it('throws InvalidRunTransition for a change that is not allowed', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(
      InvalidRunTransition,
    );
    expect(() => assertTransition('running', 'completed')).not.toThrow();
  });

  it.each<[RunStatus, boolean]>([
    ['running', true],
    ['waiting_approval', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
    ['expired', false],
  ])('%s is active: %s (H-02, H-03)', (status, active) => {
    expect(isActiveStatus(status)).toBe(active);
  });
});

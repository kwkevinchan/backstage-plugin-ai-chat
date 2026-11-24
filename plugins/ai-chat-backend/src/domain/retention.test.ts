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

import { isSessionExpired, sessionRetentionCutoff } from './retention';

describe('session retention (SE-05)', () => {
  // 2026 is not a leap year: 1 January plus 90 days is 1 April.
  const now = new Date('2026-04-01T00:00:00.000Z');
  const days = 90;

  it('treats a session as expired only when its last change is before the cutoff', () => {
    expect(sessionRetentionCutoff(now, days)?.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(isSessionExpired('2025-12-31T23:59:59.999Z', now, days)).toBe(true);
    expect(isSessionExpired('2026-01-01T00:00:00.000Z', now, days)).toBe(false);
    expect(isSessionExpired('2026-03-31T00:00:00.000Z', now, days)).toBe(false);
  });

  it('keeps every session when the retention is 0 days', () => {
    expect(sessionRetentionCutoff(now, 0)).toBeUndefined();
    expect(isSessionExpired('2020-01-01T00:00:00.000Z', now, 0)).toBe(false);
  });

  it('refuses a retention that is not an integer of at least 0', () => {
    expect(() => sessionRetentionCutoff(now, -1)).toThrow(
      /integer of at least 0/,
    );
    expect(() => sessionRetentionCutoff(now, 1.5)).toThrow(
      /integer of at least 0/,
    );
    expect(() => isSessionExpired('2020-01-01T00:00:00.000Z', now, -1)).toThrow(
      /integer of at least 0/,
    );
  });
});

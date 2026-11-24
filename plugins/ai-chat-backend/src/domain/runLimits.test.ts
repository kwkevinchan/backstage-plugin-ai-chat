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

import { CREDENTIALS_MARGIN_SECONDS, runLimits } from './runLimits';

const base = { maxSteps: 10, maxToolCallsPerRun: 30, runTimeoutSeconds: 300 };
const now = new Date('2026-01-01T00:00:00.000Z');
const inSeconds = (s: number) =>
  new Date(now.getTime() + s * 1000).toISOString();

describe('runLimits (V-06)', () => {
  it('keeps the limits when the expiry of the credentials is not known', () => {
    expect(runLimits(base, { elapsedSeconds: 0 }, {}, now)).toBe(base);
    expect(
      runLimits(base, { elapsedSeconds: 0 }, { credentialsExpireAt: 'x' }, now),
    ).toBe(base);
  });

  it('keeps the configured time when the credentials last longer', () => {
    expect(
      runLimits(
        base,
        { elapsedSeconds: 0 },
        { credentialsExpireAt: inSeconds(3600) },
        now,
      ).runTimeoutSeconds,
    ).toBe(300);
  });

  it('ends the run before the credentials expire', () => {
    expect(
      runLimits(
        base,
        { elapsedSeconds: 0 },
        { credentialsExpireAt: inSeconds(100) },
        now,
      ).runTimeoutSeconds,
    ).toBe(100 - CREDENTIALS_MARGIN_SECONDS);
  });

  it('counts the time already used: the cut is on the time left', () => {
    expect(
      runLimits(
        base,
        { elapsedSeconds: 200 },
        { credentialsExpireAt: inSeconds(100) },
        now,
      ).runTimeoutSeconds,
    ).toBe(200 + 100 - CREDENTIALS_MARGIN_SECONDS);
    expect(
      runLimits(
        base,
        { elapsedSeconds: 290 },
        { credentialsExpireAt: inSeconds(3600) },
        now,
      ).runTimeoutSeconds,
    ).toBe(300);
  });

  it('leaves no time for credentials that expired', () => {
    expect(
      runLimits(
        base,
        { elapsedSeconds: 5 },
        { credentialsExpireAt: inSeconds(-10) },
        now,
      ).runTimeoutSeconds,
    ).toBe(5);
  });
});

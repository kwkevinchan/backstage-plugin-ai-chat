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

import { FakeClock } from '@kwkevinchan/ai-chat-harness/testing';
import { sessionRetentionCutoff } from '../../domain';
import type { SessionRepository } from '../ports';
import { PurgeExpiredSessions } from './PurgeExpiredSessions';

describe('PurgeExpiredSessions (SE-05)', () => {
  const clock = new FakeClock();

  function useCase(
    sessions: Pick<SessionRepository, 'purgeExpired'>,
    retentionDays: number,
  ) {
    return new PurgeExpiredSessions({
      sessions: sessions as SessionRepository,
      clock,
      retentionDays,
    });
  }

  it('asks for sessions last changed before the cutoff of the domain rule', async () => {
    clock.advance(100 * 24 * 3600);
    let cutoff: Date | undefined;
    const deleted = await useCase(
      {
        purgeExpired: async olderThan => {
          cutoff = olderThan;
          return 2;
        },
      },
      90,
    ).execute();
    expect(deleted).toBe(2);
    expect(cutoff?.toISOString()).toBe(
      sessionRetentionCutoff(clock.now(), 90)?.toISOString(),
    );
  });

  it('deletes nothing when the retention is 0 days', async () => {
    const purgeExpired = jest.fn();
    const deleted = await useCase({ purgeExpired }, 0).execute();
    expect(deleted).toBe(0);
    expect(purgeExpired).not.toHaveBeenCalled();
  });
});

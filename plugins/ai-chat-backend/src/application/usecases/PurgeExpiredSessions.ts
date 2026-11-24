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

import type { Clock } from '@kwkevinchan/ai-chat-harness';
import { sessionRetentionCutoff } from '../../domain';
import type { SessionRepository } from '../ports';

/**
 * Deletes sessions past `retentionDays` (SE-05). `plugin.ts` runs it every
 * hour. A retention of 0 deletes nothing. The audit log is not a session and
 * is not read or written here.
 */
export class PurgeExpiredSessions {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      clock: Clock;
      retentionDays: number;
    },
  ) {}

  /** Returns how many sessions were deleted. */
  async execute(): Promise<number> {
    const cutoff = sessionRetentionCutoff(
      this.deps.clock.now(),
      this.deps.retentionDays,
    );
    if (!cutoff) return 0;
    return this.deps.sessions.purgeExpired(cutoff);
  }
}

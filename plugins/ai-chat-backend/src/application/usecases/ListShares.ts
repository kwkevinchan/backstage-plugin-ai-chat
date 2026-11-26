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
import { assertOwner, type Principal } from '../../domain';
import type { SessionRepository, ShareRepository } from '../ports';
import { shareViewOf, type ShareView } from '../shareChanges';

/**
 * The shares of a session that are not cancelled, oldest first, for its
 * owner: who sees the session and until when (SH-10).
 */
export class ListShares {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      shares: ShareRepository;
      clock: Clock;
    },
  ) {}

  /** Throws `NotSessionOwner`. */
  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<ShareView[]> {
    const session = await this.deps.sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const shares = await this.deps.shares.listBySession(session.id);
    return shares
      .filter(share => share.revokedAt === undefined)
      .map(share => shareViewOf(share, this.deps.clock));
  }
}

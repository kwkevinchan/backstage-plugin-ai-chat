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

import type { Principal, Session } from '../../domain';
import type { RunRepository, SessionRepository } from '../ports';

/**
 * A session in the list. `activity` is set when a run of it has not ended.
 * It comes from that run, not from a column of its own.
 */
export type ListedSession = Session & {
  activity?: 'running' | 'waiting_approval';
};

/** The sessions of the signed-in user, the most recently updated first. */
export class ListSessions {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<ListedSession[]> {
    const sessions = await this.deps.sessions.listByOwner(
      input.principal.userRef,
      {
        includeArchived: input.includeArchived,
        limit: input.limit,
      },
    );
    const active = await this.deps.runs.findActiveForSessions(
      sessions.map(session => session.id),
    );
    const bySession = new Map(active.map(run => [run.sessionId, run]));
    return sessions.map(session => {
      const status = bySession.get(session.id)?.status;
      return status === 'running' || status === 'waiting_approval'
        ? { ...session, activity: status }
        : session;
    });
  }
}

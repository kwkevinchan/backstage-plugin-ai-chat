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

import type { Item, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  assertOwner,
  type Principal,
  type Run,
  type Session,
} from '../../domain';
import type { RunRepository, SessionRepository } from '../ports';

/** What a screen needs to show a session. */
export type SessionView = {
  session: Session;
  /** The run that has not ended, if there is one. */
  run?: Run;
  items: Item[];
};

/** The session with its items and its active run, for the owner (SE-01). */
export class GetSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    sessionId: string;
    /** Only the items after this sequence number. */
    afterSeq?: number;
  }): Promise<SessionView> {
    const { sessions, runs, items } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const [run, list] = await Promise.all([
      runs.findActive(session.id),
      items.read(session.id, { afterSeq: input.afterSeq }),
    ]);
    return { session, ...(run && { run }), items: list };
  }
}

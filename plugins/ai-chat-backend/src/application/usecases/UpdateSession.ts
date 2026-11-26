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
  assertOwner,
  UnknownToolset,
  type Principal,
  type Session,
  type SessionPatch,
} from '../../domain';
import type { AccessControl, AgentCatalog, SessionRepository } from '../ports';
import { usableToolsets } from '../ToolsetScope';

/** Renames, pins or archives a session, or switches its toolsets (SE-03, T-11). */
export class UpdateSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      agents: AgentCatalog;
      access: Pick<AccessControl, 'usableToolsets'>;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    sessionId: string;
    patch: SessionPatch;
  }): Promise<Session> {
    const { sessions, agents } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    if (input.patch.enabledToolsets !== undefined) {
      // The user chooses among the toolsets the administrator defined, no more.
      const known = await agents.toolsets();
      // A toolset added now must be one the user may use (T-08). One the
      // session already has stays: it gives no tools while the user may not
      // use it, and gives them again when the user may.
      const usable = await usableToolsets(this.deps, input.principal);
      for (const id of input.patch.enabledToolsets) {
        const added = !session.enabledToolsets.includes(id);
        if (
          !known.some(toolset => toolset.id === id) ||
          (added && !usable.some(toolset => toolset.id === id))
        ) {
          throw new UnknownToolset(id);
        }
      }
    }
    return sessions.update(input.sessionId, input.patch);
  }
}

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
  defaultToolsetIds,
  UnknownToolset,
  type Principal,
  type Session,
} from '../../domain';
import type { AgentCatalog, SessionRepository } from '../ports';

/** Makes a session for the signed-in user (SE-01). */
export class CreateSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      agents: AgentCatalog;
    },
  ) {}

  /**
   * The session has the toolsets the user gave, or else the ones that are on
   * by default (D-24). They are always stored: a session never has "no
   * choice", so a later change of the defaults does not change it.
   */
  async execute(input: {
    principal: Principal;
    agentId?: string;
    title?: string;
    entityRef?: string;
    enabledToolsets?: string[];
  }): Promise<Session> {
    const { sessions, agents } = this.deps;
    const agentId = input.agentId ?? agents.defaultAgentId();
    await agents.agent(agentId);
    const toolsets = await agents.toolsets();
    const enabledToolsets =
      input.enabledToolsets ?? defaultToolsetIds(toolsets);
    for (const id of enabledToolsets) {
      if (!toolsets.some(toolset => toolset.id === id)) {
        throw new UnknownToolset(id);
      }
    }
    return sessions.create({
      ownerRef: input.principal.userRef,
      agentId,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.entityRef !== undefined && { entityRef: input.entityRef }),
      enabledToolsets,
    });
  }
}

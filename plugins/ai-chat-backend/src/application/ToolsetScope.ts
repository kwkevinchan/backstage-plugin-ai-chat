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
  AgentNotFound,
  offeredToolsetIds,
  type Principal,
  type Toolset,
} from '../domain';
import type { AccessControl, AgentCatalog, SessionRepository } from './ports';

/** The toolsets of the administrator that the principal may use (T-08). */
export async function usableToolsets(
  deps: {
    agents: Pick<AgentCatalog, 'toolsets'>;
    access: Pick<AccessControl, 'usableToolsets'>;
  },
  principal: Principal,
): Promise<Toolset[]> {
  const toolsets = await deps.agents.toolsets();
  const ids = new Set(
    await deps.access.usableToolsets({
      principal,
      toolsetIds: toolsets.map(toolset => toolset.id),
    }),
  );
  return toolsets.filter(toolset => ids.has(toolset.id));
}

/**
 * The toolsets whose tools go to the model in a session (T-08, T-11, X-01):
 * switched on in the session, named by its agent, and usable by the
 * principal. An agent that is no longer configured does not narrow the list.
 */
export class ToolsetScope {
  constructor(
    private readonly deps: {
      sessions: Pick<SessionRepository, 'get'>;
      agents: Pick<AgentCatalog, 'agent' | 'toolsets'>;
      access: Pick<AccessControl, 'usableToolsets'>;
    },
  ) {}

  async offered(input: {
    sessionId: string;
    principal: Principal;
  }): Promise<string[]> {
    const session = await this.deps.sessions.get(input.sessionId);
    const usable = await usableToolsets(this.deps, input.principal);
    return offeredToolsetIds(
      session.enabledToolsets,
      await this.agentToolsets(session.agentId),
      usable.map(toolset => toolset.id),
    );
  }

  private async agentToolsets(
    agentId: string,
  ): Promise<readonly string[] | undefined> {
    try {
      return (await this.deps.agents.agent(agentId)).toolsets;
    } catch (error) {
      if (error instanceof AgentNotFound) return undefined;
      throw error;
    }
  }
}

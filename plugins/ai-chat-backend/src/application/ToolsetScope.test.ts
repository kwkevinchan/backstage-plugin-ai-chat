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

import { AgentNotFound, type Principal, type Toolset } from '../domain';
import { ToolsetScope, usableToolsets } from './ToolsetScope';

const toolset = (id: string): Toolset => ({
  id,
  actions: [`${id}:*`],
  exclude: [],
  default: true,
  egress: false,
});
const principal: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: {},
};

function scope(options: {
  agentToolsets?: readonly string[];
  agentGone?: boolean;
  usable?: string[];
}) {
  const asked: string[][] = [];
  const deps = {
    sessions: {
      get: async () =>
        ({ agentId: 'sre', enabledToolsets: ['a', 'b', 'c'] } as any),
    },
    agents: {
      toolsets: async () => [toolset('a'), toolset('b'), toolset('c')],
      agent: async (agentId: string) => {
        if (options.agentGone) throw new AgentNotFound(agentId);
        return {
          id: agentId,
          title: agentId,
          systemPrompt: '',
          ...(options.agentToolsets && { toolsets: options.agentToolsets }),
        } as any;
      },
    },
    access: {
      usableToolsets: async (input: { toolsetIds: readonly string[] }) => {
        asked.push([...input.toolsetIds]);
        return input.toolsetIds.filter(
          id => options.usable === undefined || options.usable.includes(id),
        );
      },
    },
  };
  return { deps, asked, scope: new ToolsetScope(deps) };
}

describe('ToolsetScope (T-08, X-01)', () => {
  it('asks about every toolset of the administrator, and keeps the usable ones', async () => {
    const { deps, asked } = scope({ usable: ['c', 'a'] });
    expect(
      (await usableToolsets(deps, principal)).map(found => found.id),
    ).toEqual(['a', 'c']);
    expect(asked).toEqual([['a', 'b', 'c']]);
  });

  it('offers the toolsets of the session that the agent names and the user may use', async () => {
    expect(
      await scope({
        agentToolsets: ['a', 'b'],
        usable: ['b', 'c'],
      }).scope.offered({ sessionId: 's', principal }),
    ).toEqual(['b']);
  });

  it('does not narrow by an agent that is no longer configured', async () => {
    expect(
      await scope({ agentGone: true, usable: ['a', 'c'] }).scope.offered({
        sessionId: 's',
        principal,
      }),
    ).toEqual(['a', 'c']);
  });
});

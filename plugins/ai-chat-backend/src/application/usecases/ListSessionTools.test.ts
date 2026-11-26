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

import type { ToolGateway } from '@kwkevinchan/ai-chat-harness';
import { AgentNotFound, type Principal, type Session } from '../../domain';
import type { AgentCatalog, SessionRepository } from '../ports';
import { ListSessionTools } from './ListSessionTools';

const jane: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: {},
};

const session: Session = {
  id: 's1',
  ownerRef: 'user:default/jane',
  agentId: 'removed',
  enabledToolsets: [],
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const sessions = {
  get: async () => session,
} as unknown as SessionRepository;

const tools = {
  list: async () => [
    {
      id: 'demo:list-things',
      title: 'List things',
      description: 'List things: Lists the things.',
      inputSchema: { type: 'object' },
      schemaHash: 'h',
      readOnly: true,
    },
  ],
} as unknown as ToolGateway;

const skills = [{ id: 'runbook', description: 'A runbook.', load: () => '' }];

describe('ListSessionTools', () => {
  it('lists the other tools and no load_skill when the agent of the session is gone', async () => {
    const agents: Pick<AgentCatalog, 'agent' | 'policy'> = {
      agent: async id => {
        throw new AgentNotFound(id);
      },
      policy: async () => ({}),
    };
    const list = new ListSessionTools({ sessions, tools, agents, skills });

    await expect(
      list.execute({ principal: jane, sessionId: 's1' }),
    ).resolves.toEqual([
      {
        id: 'demo:list-things',
        title: 'List things',
        description: 'Lists the things.',
        readOnly: true,
      },
      expect.objectContaining({ id: 'update_plan', readOnly: true }),
    ]);
  });

  it('lists update_plan after the other tools, and leaves it out when the policy denies it', async () => {
    const policy = { byTool: {} as Record<string, 'deny'> };
    const agents: Pick<AgentCatalog, 'agent' | 'policy'> = {
      agent: async id => ({ id, systemPrompt: 'Help.' }),
      policy: async () => policy,
    };
    const list = new ListSessionTools({ sessions, tools, agents });

    const listed = await list.execute({ principal: jane, sessionId: 's1' });
    expect(listed.map(tool => tool.id)).toEqual([
      'demo:list-things',
      'update_plan',
    ]);
    expect(listed[1]).toEqual({
      id: 'update_plan',
      title: 'Update plan',
      description: expect.stringContaining('Write the plan of the work'),
      readOnly: true,
    });

    policy.byTool.update_plan = 'deny';
    expect(
      (await list.execute({ principal: jane, sessionId: 's1' })).map(
        tool => tool.id,
      ),
    ).toEqual(['demo:list-things']);
  });

  it('passes on other errors of the agent catalog', async () => {
    const agents: Pick<AgentCatalog, 'agent' | 'policy'> = {
      agent: async () => {
        throw new Error('catalog down');
      },
      policy: async () => ({}),
    };
    const list = new ListSessionTools({ sessions, tools, agents, skills });

    await expect(
      list.execute({ principal: jane, sessionId: 's1' }),
    ).rejects.toThrow('catalog down');
  });
});

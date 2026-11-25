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

import { mockServices } from '@backstage/backend-test-utils';
import {
  decidePolicy,
  type AgentDefinition,
} from '@kwkevinchan/ai-chat-harness';
import { ConfigAgentCatalog } from './ConfigAgentCatalog';

function catalogFor(
  aiChat: unknown,
  registered: readonly AgentDefinition[] = [],
) {
  const logger = mockServices.logger.mock();
  const catalog = new ConfigAgentCatalog(
    mockServices.rootConfig({ data: { aiChat } as any }),
    logger,
    registered,
  );
  return { catalog, logger };
}

const catalogToolsets = {
  catalog: { actions: ['catalog:*'] },
  web: { actions: ['web:*'] },
};

describe('ConfigAgentCatalog', () => {
  it('reads the toolsets (T-01, D-24)', async () => {
    const { catalog, logger } = catalogFor({
      toolsets: {
        catalog: { actions: ['catalog:*'], default: true, title: 'Catalog' },
        web: { actions: ['web:*'], egress: true },
      },
    });
    expect(await catalog.toolsets()).toEqual([
      {
        id: 'catalog',
        title: 'Catalog',
        actions: ['catalog:*'],
        exclude: [],
        default: true,
        egress: false,
      },
      {
        id: 'web',
        title: undefined,
        actions: ['web:*'],
        exclude: [],
        default: false,
        egress: true,
      },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('turns the flat policy into byTool', async () => {
    const { catalog } = catalogFor({
      policy: { 'temporal:terminate-workflow': 'deny', 'catalog:get': 'allow' },
    });
    const settings = await catalog.policy();
    expect(settings).toEqual({
      byTool: { 'temporal:terminate-workflow': 'deny', 'catalog:get': 'allow' },
    });
    const tool = {
      id: 'temporal:terminate-workflow',
      description: '',
      inputSchema: {},
      schemaHash: 'h',
      readOnly: true,
    };
    expect(decidePolicy(tool, settings)).toBe('deny');
  });

  it('has no policy settings without a policy block', async () => {
    const { catalog } = catalogFor({});
    expect(await catalog.policy()).toEqual({});
  });

  it('rejects a policy value that is not allow, ask or deny', () => {
    expect(() => catalogFor({ policy: { 'a:b': 'auto' } })).toThrow(
      'aiChat.policy.a:b must be allow, ask or deny',
    );
  });

  it('rejects a toolset without actions or with a bad id', () => {
    expect(() => catalogFor({ toolsets: { a: { actions: [] } } })).toThrow(
      'aiChat.toolsets.a.actions must not be empty',
    );
    expect(() =>
      catalogFor({ toolsets: { 'a b': { actions: ['x'] } } }),
    ).toThrow('the id must start with a letter');
  });

  it('offers every action in one default toolset when nothing is configured', async () => {
    const { catalog, logger } = catalogFor({});
    expect(await catalog.toolsets()).toEqual([
      {
        id: 'default',
        actions: ['*'],
        exclude: [],
        default: true,
        egress: false,
      },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('turns the deprecated include and exclude into one toolset and warns', async () => {
    const { catalog, logger } = catalogFor({
      actions: { include: ['catalog:*'], exclude: ['catalog:delete'] },
    });
    expect(await catalog.toolsets()).toEqual([
      {
        id: 'default',
        actions: ['catalog:*'],
        exclude: ['catalog:delete'],
        default: true,
        egress: false,
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
    );
  });

  it('warns that the deprecated lists are ignored when toolsets are set', async () => {
    const { catalog, logger } = catalogFor({
      actions: { include: ['x:*'] },
      toolsets: { a: { actions: ['a:*'] } },
    });
    expect((await catalog.toolsets()).map(t => t.id)).toEqual(['a']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored because aiChat.toolsets is set'),
    );
  });

  it('rejects a policy key that is a pattern', () => {
    expect(() => catalogFor({ policy: { 'catalog:*': 'deny' } })).toThrow(
      'complete action id',
    );
  });

  it('reads the exclude patterns of a toolset', async () => {
    const { catalog } = catalogFor({
      toolsets: { a: { actions: ['a:*'], exclude: ['a:delete-*'] } },
    });
    expect((await catalog.toolsets())[0].exclude).toEqual(['a:delete-*']);
  });

  it.each(['1a', '-a', 'a-', 'a--b', 'a_'])('rejects the toolset id %s', id => {
    expect(() =>
      catalogFor({ toolsets: { [id]: { actions: ['x'] } } }),
    ).toThrow('the id must start with a letter');
  });

  describe('the agent', () => {
    it('is the default agent, with the built-in rules and the instructions of the operator', async () => {
      const { catalog } = catalogFor({ systemPrompt: 'Be brief.' });
      expect(catalog.defaultAgentId()).toBe('default');
      const agent = await catalog.agent('default');
      expect(agent.id).toBe('default');
      expect(agent.systemPrompt).toContain('Be brief.');
      expect(agent.systemPrompt).toContain('Rules that always apply');
    });

    it('throws AgentNotFound for another id', async () => {
      const { catalog } = catalogFor({});
      await expect(catalog.agent('other')).rejects.toMatchObject({
        code: 'AGENT_NOT_FOUND',
      });
    });

    it('reads an agent from aiChat.agents, and keeps the built-in default', async () => {
      const { catalog } = catalogFor({
        systemPrompt: 'Be brief.',
        toolsets: catalogToolsets,
        agents: {
          sre: {
            title: 'SRE Agent',
            systemPrompt: 'Cite the source for example.com.',
            toolsets: ['catalog'],
            skills: ['deploy-failure', 'rollback'],
            model: 'default',
            planning: 'required',
            limits: {
              maxSteps: 8,
              maxToolCallsPerRun: 20,
              runTimeoutSeconds: 300,
            },
          },
        },
      });
      const sre = await catalog.agent('sre');
      expect(sre).toEqual({
        id: 'sre',
        title: 'SRE Agent',
        systemPrompt: expect.stringContaining(
          'Cite the source for example.com.',
        ),
        toolsets: ['catalog'],
        skills: ['deploy-failure', 'rollback'],
        model: 'default',
        planning: 'required',
        limits: { maxSteps: 8, maxToolCallsPerRun: 20, runTimeoutSeconds: 300 },
      });
      expect(sre.systemPrompt).toContain('Rules that always apply');
      expect(sre.systemPrompt).not.toContain('Be brief.');
      const fallback = await catalog.agent('default');
      expect(fallback.systemPrompt).toContain('Rules that always apply');
      expect(fallback.systemPrompt).toContain('Be brief.');
      expect(fallback.title).toBeUndefined();
      expect(fallback.toolsets).toBeUndefined();
      expect(catalog.defaultAgentId()).toBe('default');
    });

    it('uses the global system prompt when the configured agent omits its own', async () => {
      const { catalog } = catalogFor({
        systemPrompt: 'Be brief.',
        agents: { sre: { title: 'SRE Agent' } },
      });
      const sre = await catalog.agent('sre');
      expect(sre.title).toBe('SRE Agent');
      expect(sre.systemPrompt).toContain('Be brief.');
      expect(sre.systemPrompt).toContain('Rules that always apply');
      expect(sre.toolsets).toBeUndefined();
      expect(sre.skills).toBeUndefined();
      expect(sre.model).toBeUndefined();
      expect(sre.limits).toBeUndefined();
      expect(sre.planning).toBeUndefined();
    });

    it('uses the configured default agent, and not the installation system prompt when the agent has its own', async () => {
      const { catalog } = catalogFor({
        systemPrompt: 'Global only.',
        toolsets: catalogToolsets,
        agents: {
          default: {
            title: 'Custom',
            systemPrompt: 'Agent only.',
            toolsets: ['catalog'],
          },
        },
      });
      const agent = await catalog.agent('default');
      expect(agent).toMatchObject({
        id: 'default',
        title: 'Custom',
        toolsets: ['catalog'],
      });
      expect(agent.systemPrompt).toContain('Agent only.');
      expect(agent.systemPrompt).toContain('Rules that always apply');
      expect(agent.systemPrompt).not.toContain('Global only.');
      expect(agent.skills).toBeUndefined();
      expect(agent.model).toBeUndefined();
      expect(agent.limits).toBeUndefined();
      expect(agent.planning).toBeUndefined();
    });

    it('stores a limit of 0', async () => {
      const { catalog } = catalogFor({
        agents: {
          sre: {
            limits: {
              maxSteps: 0,
              maxToolCallsPerRun: 0,
              runTimeoutSeconds: 0,
            },
          },
        },
      });
      expect((await catalog.agent('sre')).limits).toEqual({
        maxSteps: 0,
        maxToolCallsPerRun: 0,
        runTimeoutSeconds: 0,
      });
    });

    it.each<[string, unknown]>([
      ['a bad id', { agents: { 'bad id': { systemPrompt: 'x' } } }],
      ['an unknown toolset', { agents: { sre: { toolsets: ['missing'] } } }],
      ['an agent that is not an object', { agents: { sre: 'no' } }],
      ['agents that are not a map', { agents: ['sre'] }],
      ['a model that is not an id', { agents: { sre: { model: '1bad' } } }],
      [
        'a planning mode that is not required',
        { agents: { sre: { planning: 'optional' } } },
      ],
      ['a limit below zero', { agents: { sre: { limits: { maxSteps: -1 } } } }],
      [
        'a limit that is not an integer',
        { agents: { sre: { limits: { maxToolCallsPerRun: 1.5 } } } },
      ],
      [
        'a timeout above 600',
        { agents: { sre: { limits: { runTimeoutSeconds: 601 } } } },
      ],
      [
        'a repeated skill',
        { agents: { sre: { skills: ['deploy-failure', 'deploy-failure'] } } },
      ],
      [
        'a skill id that is not valid',
        { agents: { sre: { skills: ['Bad Skill'] } } },
      ],
      [
        'toolsets that are not ids',
        { agents: { sre: { toolsets: 'catalog' } } },
      ],
    ])('rejects an agent the configuration gets wrong: %s', (_name, aiChat) => {
      expect(() => catalogFor(aiChat)).toThrow(/aiChat\.agents/);
    });

    it('keeps an extension agent next to the configured agents, with the built-in rules and the prompt the module gave', async () => {
      const { catalog } = catalogFor(
        {
          toolsets: catalogToolsets,
          agents: { sre: { title: 'SRE Agent' } },
        },
        [
          {
            id: 'guide',
            title: 'Guide',
            systemPrompt: 'You help people on example.com.',
            skills: ['getting-started'],
            planning: 'required',
          },
        ],
      );
      const guide = await catalog.agent('guide');
      expect(guide.systemPrompt).toContain('Rules that always apply');
      expect(guide.systemPrompt).toContain('You help people on example.com.');
      expect(guide).toMatchObject({
        title: 'Guide',
        skills: ['getting-started'],
        planning: 'required',
      });
      expect((await catalog.agent('sre')).title).toBe('SRE Agent');
      expect((await catalog.agent('default')).id).toBe('default');
    });

    it('rejects an agent id that the configuration and an extension both define', () => {
      expect(() =>
        catalogFor({ agents: { guide: { title: 'From the file' } } }, [
          { id: 'guide', systemPrompt: 'From the module.' },
        ]),
      ).toThrow(/agent guide is already defined/);
    });

    it('rejects an extension that registers the default agent', () => {
      expect(() =>
        catalogFor({}, [{ id: 'default', systemPrompt: 'no' }]),
      ).toThrow(/agent default is already defined/);
    });

    it('rejects an extension agent that names an unknown toolset', () => {
      expect(() =>
        catalogFor({}, [
          { id: 'guide', systemPrompt: 'x', toolsets: ['missing'] },
        ]),
      ).toThrow(/agent guide\.toolsets: unknown toolset missing/);
    });

    it('rejects agents naming unknown skills when knownSkills is provided and accepts valid skills', async () => {
      const knownSkills = new Set(['getting-started', 'deploy-failure']);
      expect(
        () =>
          new ConfigAgentCatalog(
            mockServices.rootConfig({
              data: {
                aiChat: {
                  agents: { sre: { skills: ['deploy-failure', 'missing'] } },
                },
              },
            }),
            mockServices.logger.mock(),
            [],
            knownSkills,
          ),
      ).toThrow(/aiChat\.agents\.sre\.skills: unknown skill missing/);

      expect(
        () =>
          new ConfigAgentCatalog(
            mockServices.rootConfig({ data: { aiChat: {} } }),
            mockServices.logger.mock(),
            [{ id: 'guide', systemPrompt: 'x', skills: ['unknown-skill'] }],
            knownSkills,
          ),
      ).toThrow(/agent guide\.skills: unknown skill unknown-skill/);

      const catalog = new ConfigAgentCatalog(
        mockServices.rootConfig({
          data: {
            aiChat: {
              agents: { sre: { skills: ['deploy-failure'] } },
            },
          },
        }),
        mockServices.logger.mock(),
        [{ id: 'guide', systemPrompt: 'x', skills: ['getting-started'] }],
        knownSkills,
      );
      expect((await catalog.agent('sre')).skills).toEqual(['deploy-failure']);
      expect((await catalog.agent('guide')).skills).toEqual([
        'getting-started',
      ]);
    });
  });
});

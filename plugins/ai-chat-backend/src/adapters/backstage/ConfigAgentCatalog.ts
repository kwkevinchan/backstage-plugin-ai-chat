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

import type { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type {
  AgentDefinition,
  PolicyName,
  PolicySettings,
} from '@kwkevinchan/ai-chat-harness';
import type { AgentCatalog } from '../../application/ports/AgentCatalog';
import { AgentNotFound } from '../../domain/errors';
import { buildSystemPrompt } from '../../domain/systemPrompt';
import type { Toolset } from '../../domain/toolset';
import {
  assertExtensionId,
  assertKnownSkills,
  assertKnownToolsets,
  definitionFrom,
  readAgentBody,
  readExtensionAgent,
} from './agentShape';

const TOOLSET_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i;
const DEFAULT_AGENT_ID = 'default';
const POLICY_NAMES: readonly string[] = ['allow', 'ask', 'deny'];

/**
 * The toolsets, the policy and the agents from the `aiChat` section of the
 * configuration, plus the agents a backend module registered. It reads and
 * checks them when it is created, so a mistake stops the backend at startup.
 *
 * Without `aiChat.agents`, and with no module defining `default`, the only
 * agent is `default`: the built-in system prompt plus `aiChat.systemPrompt`.
 * `aiChat.agents.default` replaces that agent. A module that also registers
 * `default` is a duplicate and stops the backend.
 *
 * The system prompt of a configured agent is the built-in rules plus that
 * agent's `systemPrompt`, or plus `aiChat.systemPrompt` when the agent omits
 * it. The two extra texts are not combined. An agent from a module keeps the
 * system prompt the module passed.
 *
 * `skills` chooses which registered skills the agent offers through
 * `load_skill`: all of them when it is omitted, none when it is empty. An id
 * that no skill has stops the backend. `planning: required` gives the agent
 * only `update_plan` in the first step of every run. `toolsets`, `model` and
 * `limits` are recorded; the loop does not apply them yet.
 *
 * Without `aiChat.toolsets` it builds one toolset, `default`, switched on for
 * every session, from the deprecated `aiChat.actions.include` and
 * `aiChat.actions.exclude` (all actions when both are empty), and warns when
 * either is set.
 */
export class ConfigAgentCatalog implements AgentCatalog {
  private readonly toolsetList: readonly Toolset[];
  private readonly policySettings: PolicySettings;
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(
    root: Config,
    logger: LoggerService,
    registeredAgents: readonly AgentDefinition[] = [],
    knownSkills?: ReadonlySet<string>,
  ) {
    const config = root.getOptionalConfig('aiChat');
    const include = config?.getOptionalStringArray('actions.include') ?? [];
    const exclude = config?.getOptionalStringArray('actions.exclude') ?? [];
    const toolsetsConfig = config?.getOptionalConfig('toolsets');

    if (include.length > 0 || exclude.length > 0) {
      logger.warn(
        toolsetsConfig
          ? 'aiChat.actions.include and aiChat.actions.exclude are deprecated, and ignored because aiChat.toolsets is set.'
          : 'aiChat.actions.include and aiChat.actions.exclude are deprecated. They make the default toolset; define aiChat.toolsets instead.',
      );
    }

    this.toolsetList = toolsetsConfig
      ? readToolsets(toolsetsConfig)
      : [
          {
            id: 'default',
            actions: include.length > 0 ? include : ['*'],
            exclude,
            default: true,
            egress: false,
          },
        ];
    this.policySettings = readPolicy(config?.getOptional('policy'));

    const knownToolsets = new Set(this.toolsetList.map(toolset => toolset.id));
    const globalPrompt = config?.getOptionalString('systemPrompt');
    for (const agent of readConfiguredAgents(
      config,
      knownToolsets,
      knownSkills,
      globalPrompt,
    )) {
      this.agents.set(agent.id, agent);
    }
    if (!this.agents.has(DEFAULT_AGENT_ID)) {
      this.agents.set(DEFAULT_AGENT_ID, {
        id: DEFAULT_AGENT_ID,
        systemPrompt: buildSystemPrompt(globalPrompt),
      });
    }
    for (const registered of registeredAgents) {
      const agent = readExtensionAgent(registered);
      assertKnownToolsets(agent.toolsets, knownToolsets, `agent ${agent.id}`);
      if (knownSkills) {
        assertKnownSkills(agent.skills, knownSkills, `agent ${agent.id}`);
      }
      if (this.agents.has(agent.id)) {
        throw new InputError(`agent ${agent.id} is already defined`);
      }
      this.agents.set(agent.id, {
        ...agent,
        systemPrompt: buildSystemPrompt(agent.systemPrompt),
      });
    }
  }

  defaultAgentId(): string {
    return DEFAULT_AGENT_ID;
  }

  async agent(agentId: string): Promise<AgentDefinition> {
    const found = this.agents.get(agentId);
    if (!found) throw new AgentNotFound(agentId);
    return found;
  }

  async toolsets(): Promise<readonly Toolset[]> {
    return this.toolsetList;
  }

  async policy(): Promise<PolicySettings> {
    return this.policySettings;
  }
}

/**
 * `aiChat.agents`, or nothing when the block is absent. A value that is not a
 * map of agent objects throws, and so does an agent that names a toolset the
 * installation does not have.
 */
function readConfiguredAgents(
  config: Config | undefined,
  knownToolsets: ReadonlySet<string>,
  knownSkills: ReadonlySet<string> | undefined,
  globalPrompt: string | undefined,
): AgentDefinition[] {
  if (!config) return [];
  const raw = config.getOptional('agents');
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputError('aiChat.agents must be a map of agent ids');
  }
  const agents = config.getOptionalConfig('agents');
  if (!agents) {
    throw new InputError('aiChat.agents must be a map of agent ids');
  }
  return agents.keys().map(id => {
    assertExtensionId(id, `aiChat.agents.${id}`);
    const body = readAgentBody(agents.get(id), `aiChat.agents.${id}`);
    assertKnownToolsets(body.toolsets, knownToolsets, `aiChat.agents.${id}`);
    if (knownSkills) {
      assertKnownSkills(body.skills, knownSkills, `aiChat.agents.${id}`);
    }
    return definitionFrom(
      id,
      body,
      buildSystemPrompt(body.systemPrompt ?? globalPrompt),
    );
  });
}

function readToolsets(config: Config): Toolset[] {
  return config.keys().map(id => {
    if (!TOOLSET_ID.test(id)) {
      throw new InputError(
        `aiChat.toolsets.${id}: the id must start with a letter and may only have letters, digits, - and _ between them`,
      );
    }
    const toolset = config.getConfig(id);
    const actions = toolset.getStringArray('actions');
    if (actions.length === 0) {
      throw new InputError(`aiChat.toolsets.${id}.actions must not be empty`);
    }
    return {
      id,
      title: toolset.getOptionalString('title'),
      actions,
      exclude: toolset.getOptionalStringArray('exclude') ?? [],
      default: toolset.getOptionalBoolean('default') ?? false,
      egress: toolset.getOptionalBoolean('egress') ?? false,
    };
  });
}

/** The flat `{toolId: allow|ask|deny}` of the configuration, as `byTool`. */
function readPolicy(value: unknown): PolicySettings {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError(
      'aiChat.policy must map tool ids to allow, ask or deny',
    );
  }
  const byTool: Record<string, PolicyName> = Object.create(null);
  for (const [toolId, name] of Object.entries(value)) {
    if (typeof name !== 'string' || !POLICY_NAMES.includes(name)) {
      throw new InputError(
        `aiChat.policy.${toolId} must be allow, ask or deny`,
      );
    }
    if (toolId.includes('*')) {
      throw new InputError(
        `aiChat.policy.${toolId}: policy takes only a complete action id, not a pattern`,
      );
    }
    byTool[toolId] = name as PolicyName;
  }
  return { byTool };
}

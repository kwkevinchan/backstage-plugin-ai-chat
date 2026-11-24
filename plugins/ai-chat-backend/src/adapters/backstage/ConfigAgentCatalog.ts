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
import type { PolicyName, PolicySettings } from '@kwkevinchan/ai-chat-harness';
import type { AgentCatalog } from '../../application/ports/AgentCatalog';
import type { Toolset } from '../../domain/toolset';

const TOOLSET_ID = /^[A-Za-z0-9_-]+$/;
const POLICY_NAMES: readonly string[] = ['allow', 'ask', 'deny'];

/**
 * The toolsets and the policy from the `aiChat` section of the configuration.
 * It reads and checks them when it is created, so a mistake stops the backend
 * at startup.
 *
 * Without `aiChat.toolsets` it builds one toolset, `default`, switched on for
 * every session, from the deprecated `aiChat.actions.include` and
 * `aiChat.actions.exclude` (all actions when both are empty), and warns when
 * either is set.
 */
export class ConfigAgentCatalog implements AgentCatalog {
  private readonly toolsetList: readonly Toolset[];
  private readonly policySettings: PolicySettings;

  constructor(root: Config, logger: LoggerService) {
    const config = root.getOptionalConfig('aiChat');
    const include = config?.getOptionalStringArray('actions.include') ?? [];
    const exclude = config?.getOptionalStringArray('actions.exclude') ?? [];
    const toolsetsConfig = config?.getOptionalConfig('toolsets');

    if (include.length > 0 || exclude.length > 0) {
      logger.warn(
        toolsetsConfig
          ? 'aiChat.actions.include and aiChat.actions.exclude are deprecated and ignored because aiChat.toolsets is set; remove them'
          : 'aiChat.actions.include and aiChat.actions.exclude are deprecated; define aiChat.toolsets instead',
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
  }

  async toolsets(): Promise<readonly Toolset[]> {
    return this.toolsetList;
  }

  async policy(): Promise<PolicySettings> {
    return this.policySettings;
  }
}

function readToolsets(config: Config): Toolset[] {
  return config.keys().map(id => {
    if (!TOOLSET_ID.test(id)) {
      throw new InputError(
        `aiChat.toolsets.${id}: the id may only have letters, digits, - and _`,
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
      exclude: [],
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
    byTool[toolId] = name as PolicyName;
  }
  return { byTool };
}

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

import { InputError } from '@backstage/errors';
import type {
  AgentDefinition,
  AiChatHarnessExtensionPoint,
  Extensions,
  HookName,
  HookRegistry,
  Hooks,
} from '@kwkevinchan/ai-chat-harness';
import { readExtensionAgent } from './agentShape';

const HOOK_NAMES: readonly HookName[] = [
  'beforeModelCall',
  'beforeToolCall',
  'afterToolCall',
  'onRunEnd',
];

function isHookName(value: unknown): value is HookName {
  return typeof value === 'string' && HOOK_NAMES.includes(value as HookName);
}

/**
 * What backend modules add through `aiChatHarnessExtensionPoint` (X-02).
 * The plugin registers this object before the modules run, then reads the
 * agents and hooks when it builds the catalog and the host.
 */
export class AiChatHarnessRegistry implements AiChatHarnessExtensionPoint {
  private readonly agentList: AgentDefinition[] = [];
  private readonly hookLists: {
    [K in HookName]: Hooks[K][];
  } = {
    beforeModelCall: [],
    beforeToolCall: [],
    afterToolCall: [],
    onRunEnd: [],
  };

  addAgent(agent: AgentDefinition): void {
    const checked = readExtensionAgent(agent);
    if (this.agentList.some(existing => existing.id === checked.id)) {
      throw new InputError(`agent ${checked.id} is already registered`);
    }
    this.agentList.push(checked);
  }

  addHook<K extends HookName>(name: K, hook: Hooks[K]): void {
    if (!isHookName(name)) {
      throw new InputError(`unknown hook: ${String(name)}`);
    }
    if (typeof hook !== 'function') {
      throw new InputError(`hook ${name} must be a function`);
    }
    this.hookLists[name].push(hook);
  }

  agents(): readonly AgentDefinition[] {
    return [...this.agentList];
  }

  hooks(): HookRegistry {
    return {
      beforeModelCall: [...this.hookLists.beforeModelCall],
      beforeToolCall: [...this.hookLists.beforeToolCall],
      afterToolCall: [...this.hookLists.afterToolCall],
      onRunEnd: [...this.hookLists.onRunEnd],
    };
  }

  hookCount(): number {
    return HOOK_NAMES.reduce(
      (sum, name) => sum + this.hookLists[name].length,
      0,
    );
  }

  extensions(): Extensions {
    return { hooks: this.hooks() };
  }
}

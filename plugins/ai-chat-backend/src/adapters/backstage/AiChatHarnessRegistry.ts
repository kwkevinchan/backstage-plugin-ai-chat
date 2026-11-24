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
  ContextProvider,
  Extensions,
  HookName,
  Hooks,
  ModelClient,
  Skill,
} from '@kwkevinchan/ai-chat-harness';
import { assertExtensionId, readExtensionAgent } from './agentShape';

const HOOK_NAMES: readonly HookName[] = [
  'beforeModelCall',
  'beforeToolCall',
  'afterToolCall',
  'onRunEnd',
];

/**
 * What backend modules add through `aiChatHarnessExtensionPoint` (X-02).
 * The plugin registers this object before the modules run, then reads it
 * when it builds the catalog and the loop. A repeated id is refused and the
 * first registration stays. The loop does not call any of this yet.
 */
export class AiChatHarnessRegistry implements AiChatHarnessExtensionPoint {
  private readonly agentList: AgentDefinition[] = [];
  private readonly providerList: ContextProvider[] = [];
  private readonly skillList: Skill[] = [];
  private readonly hookLists: { [K in HookName]: Hooks[K][] } = {
    beforeModelCall: [],
    beforeToolCall: [],
    afterToolCall: [],
    onRunEnd: [],
  };
  private readonly clients = new Map<string, ModelClient>();

  addAgent(agent: AgentDefinition): void {
    const checked = readExtensionAgent(agent);
    if (this.agentList.some(existing => existing.id === checked.id)) {
      throw new InputError(`agent ${checked.id} is already registered`);
    }
    this.agentList.push(checked);
  }

  addContextProvider(provider: ContextProvider): void {
    const id = readId(provider, 'context provider');
    if (this.providerList.some(existing => existing.id === id)) {
      throw new InputError(`context provider ${id} is already registered`);
    }
    if (typeof provider.provide !== 'function') {
      throw new InputError(
        `context provider ${id}: provide must be a function`,
      );
    }
    this.providerList.push(provider);
  }

  addSkill(skill: Skill): void {
    const id = readId(skill, 'skill');
    if (this.skillList.some(existing => existing.id === id)) {
      throw new InputError(`skill ${id} is already registered`);
    }
    if (typeof skill.description !== 'string') {
      throw new InputError(`skill ${id}: description must be a string`);
    }
    if (typeof skill.load !== 'function') {
      throw new InputError(`skill ${id}: load must be a function`);
    }
    this.skillList.push(skill);
  }

  addHook<K extends HookName>(name: K, hook: Hooks[K]): void {
    const list = this.hookList(name);
    if (typeof hook !== 'function') {
      throw new InputError(`hook ${name} must be a function`);
    }
    list.push(hook);
  }

  setModelClient(id: string, client: ModelClient): void {
    assertExtensionId(id, `model ${id}`);
    if (this.clients.has(id)) {
      throw new InputError(`model ${id} is already registered`);
    }
    if (
      typeof client?.stream !== 'function' ||
      typeof client.capabilities !== 'object' ||
      client.capabilities === null
    ) {
      throw new InputError(
        `model ${id}: the client needs stream and capabilities`,
      );
    }
    this.clients.set(id, client);
  }

  agents(): readonly AgentDefinition[] {
    return [...this.agentList];
  }

  contextProviders(): readonly ContextProvider[] {
    return [...this.providerList];
  }

  skills(): readonly Skill[] {
    return [...this.skillList];
  }

  hooks<K extends HookName>(name: K): readonly Hooks[K][] {
    return [...this.hookList(name)];
  }

  modelClient(id: string): ModelClient | undefined {
    return this.clients.get(id);
  }

  modelClients(): ReadonlyMap<string, ModelClient> {
    return new Map(this.clients);
  }

  /** The bag the loop receives. Nothing in it is called in this version. */
  extensions(): Extensions {
    return {
      contextProviders: this.contextProviders(),
      skills: this.skills(),
      hooks: {
        beforeModelCall: this.hooks('beforeModelCall'),
        beforeToolCall: this.hooks('beforeToolCall'),
        afterToolCall: this.hooks('afterToolCall'),
        onRunEnd: this.hooks('onRunEnd'),
      },
      modelClients: this.modelClients(),
    };
  }

  private hookList<K extends HookName>(name: K): Hooks[K][] {
    if (!HOOK_NAMES.includes(name)) {
      throw new InputError(`unknown hook ${String(name)}`);
    }
    return this.hookLists[name];
  }
}

function readId(value: { id?: unknown }, kind: string): string {
  if (typeof value?.id !== 'string') {
    throw new InputError(`${kind}: id must be a string`);
  }
  assertExtensionId(value.id, `${kind} ${value.id}`);
  return value.id;
}

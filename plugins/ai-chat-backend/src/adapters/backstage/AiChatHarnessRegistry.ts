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
  ToolResult,
} from '@kwkevinchan/ai-chat-harness';
import type { Logger } from '../../application/ports';
import type { ToolOutputRule } from '../../domain';
import { limitToolResult, toolOutputLimitsOf } from './ActionsToolGateway';
import { assertExtensionId, readExtensionAgent } from './agentShape';
import { readExtensionContextProvider } from './contextProviderShape';
import { readExtensionSkill } from './skillShape';

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
 * agents, hooks, skills, model clients and context providers when it builds
 * the catalog and the host. A repeated agent, skill, model or context provider
 * id is refused and the first registration stays.
 */
export class AiChatHarnessRegistry implements AiChatHarnessExtensionPoint {
  private readonly agentList: AgentDefinition[] = [];
  private readonly skillList: Skill[] = [];
  private readonly modelClientMap = new Map<string, ModelClient>();
  private readonly contextProviderList: ContextProvider[] = [];
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

  addSkill(skill: Skill): void {
    const checked = readExtensionSkill(skill);
    if (this.skillList.some(existing => existing.id === checked.id)) {
      throw new InputError(`skill ${checked.id} is already registered`);
    }
    this.skillList.push(checked);
  }

  /**
   * Checks the id and the shape of the client: `stream` is a function, and
   * `capabilities` has booleans `parallelToolCalls` and `images`. Whether the
   * id is also a configured model is checked by the plugin at startup.
   */
  addModelClient(id: string, client: ModelClient): void {
    if (typeof id !== 'string') {
      throw new InputError('a model client needs a string id');
    }
    assertExtensionId(id, `model client ${id}`);
    const shape = client as Partial<ModelClient> | null | undefined;
    const capabilities = shape?.capabilities as
      | Partial<ModelClient['capabilities']>
      | undefined;
    if (
      typeof shape?.stream !== 'function' ||
      typeof capabilities !== 'object' ||
      capabilities === null ||
      typeof capabilities.parallelToolCalls !== 'boolean' ||
      typeof capabilities.images !== 'boolean'
    ) {
      throw new InputError(
        `model client ${id} must have a stream function and boolean capabilities parallelToolCalls and images`,
      );
    }
    if (this.modelClientMap.has(id)) {
      throw new InputError(`model client ${id} is already registered`);
    }
    this.modelClientMap.set(id, client);
  }

  addContextProvider(provider: ContextProvider): void {
    const checked = readExtensionContextProvider(provider);
    if (this.contextProviderList.some(existing => existing.id === checked.id)) {
      throw new InputError(
        `context provider ${checked.id} is already registered`,
      );
    }
    this.contextProviderList.push(checked);
  }

  agents(): readonly AgentDefinition[] {
    return [...this.agentList];
  }

  skills(): readonly Skill[] {
    return [...this.skillList];
  }

  modelClients(): ReadonlyMap<string, ModelClient> {
    return new Map(this.modelClientMap);
  }

  contextProviderCount(): number {
    return this.contextProviderList.length;
  }

  hookCount(): number {
    return HOOK_NAMES.reduce(
      (sum, name) => sum + this.hookLists[name].length,
      0,
    );
  }

  /**
   * The hooks as the loop and the host call them. Each hook logs what it
   * throws, with its name, and throws it again: the loop decides what a
   * failure means. When a module changes tool results, the changed output
   * loses the fields to hide and is cut to the limit of its tool after the
   * last `afterToolCall` hook, as the tool gateway treats the output of a
   * tool (T-09).
   *
   * The context providers of the modules come after `builtIns`, in the order
   * they were registered. Each one logs what it throws, with its id and the
   * run, and throws it again: the loop leaves its text out of that step.
   */
  extensions(opts: {
    logger: Logger;
    maxToolOutputChars: number;
    builtInContextProviders?: readonly ContextProvider[];
    toolOutput?: readonly ToolOutputRule[];
  }): Extensions {
    const { logger, maxToolOutputChars, toolOutput = [] } = opts;
    const afterToolCall = this.hookLists.afterToolCall.map(hook =>
      logged('afterToolCall', hook, logger),
    );
    if (afterToolCall.length > 0) {
      afterToolCall.push((call, result: ToolResult) =>
        limitToolResult(
          result,
          toolOutputLimitsOf(call.toolId, toolOutput, maxToolOutputChars),
        ),
      );
    }
    return {
      hooks: {
        beforeModelCall: this.hookLists.beforeModelCall.map(hook =>
          logged('beforeModelCall', hook, logger),
        ),
        beforeToolCall: this.hookLists.beforeToolCall.map(hook =>
          logged('beforeToolCall', hook, logger),
        ),
        afterToolCall,
        onRunEnd: this.hookLists.onRunEnd.map(hook =>
          logged('onRunEnd', hook, logger),
        ),
      },
      contextProviders: [
        ...(opts.builtInContextProviders ?? []),
        ...this.contextProviderList,
      ].map(provider => loggedProvider(provider, logger)),
    };
  }
}

function loggedProvider(
  provider: ContextProvider,
  logger: Logger,
): ContextProvider {
  return {
    id: provider.id,
    async provide(ctx) {
      try {
        return await provider.provide(ctx);
      } catch (error) {
        logger.warn('An AI chat context provider failed', {
          contextProvider: provider.id,
          runId: ctx.runId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function logged<K extends HookName>(
  name: K,
  hook: Hooks[K],
  logger: Logger,
): Hooks[K] {
  const call = hook as (...args: unknown[]) => unknown;
  const wrapped = async (...args: unknown[]) => {
    try {
      return await call(...args);
    } catch (error) {
      logger.warn(`An AI chat ${name} hook failed`, {
        hook: name,
        ...definedOf(whereOf(name, args)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  return wrapped as unknown as Hooks[K];
}

/**
 * Which run, or which call, a failed hook was called for. `afterToolCall`
 * gets no context, so its call id stands for the run.
 */
function whereOf(
  name: HookName,
  args: unknown[],
): { runId?: string; callId?: string } {
  const field = (value: unknown, key: string): string | undefined => {
    const found =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
    return typeof found === 'string' ? found : undefined;
  };
  switch (name) {
    case 'beforeModelCall':
    case 'onRunEnd':
      return { runId: field(args[0], 'runId') };
    case 'beforeToolCall':
      return {
        runId: field(args[1], 'runId'),
        callId: field(args[0], 'callId'),
      };
    case 'afterToolCall':
      return { callId: field(args[0], 'callId') };
    default:
      return name satisfies never;
  }
}

function definedOf(fields: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

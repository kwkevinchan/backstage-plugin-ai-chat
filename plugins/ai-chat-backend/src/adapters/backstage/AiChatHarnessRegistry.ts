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
  Hooks,
  Skill,
  ToolResult,
} from '@kwkevinchan/ai-chat-harness';
import type { Logger } from '../../application/ports';
import { limitToolResult } from './ActionsToolGateway';
import { readExtensionAgent } from './agentShape';
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
 * agents, hooks and skills when it builds the catalog and the host. A
 * repeated agent or skill id is refused and the first registration stays.
 */
export class AiChatHarnessRegistry implements AiChatHarnessExtensionPoint {
  private readonly agentList: AgentDefinition[] = [];
  private readonly skillList: Skill[] = [];
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

  agents(): readonly AgentDefinition[] {
    return [...this.agentList];
  }

  skills(): readonly Skill[] {
    return [...this.skillList];
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
   * failure means. When a module changes tool results, the changed output is
   * cut to `maxToolOutputChars` after the last `afterToolCall` hook, as the
   * tool gateway cuts the output of a tool.
   */
  extensions(opts: { logger: Logger; maxToolOutputChars: number }): Extensions {
    const { logger, maxToolOutputChars } = opts;
    const afterToolCall = this.hookLists.afterToolCall.map(hook =>
      logged('afterToolCall', hook, logger),
    );
    if (afterToolCall.length > 0) {
      afterToolCall.push((_call, result: ToolResult) =>
        limitToolResult(result, maxToolOutputChars),
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
    };
  }
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

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

import type { AgentDefinition } from '../../domain/agent';
import type { ToolCallItem, ToolResultBody } from '../../domain/item';
import type { RunStatus } from '../../domain/run';
import type { ModelClient } from './ModelClient';

/**
 * A tool call as a hook sees it: the call item of the log.
 *
 * @public
 */
export type ToolCall = ToolCallItem;

/**
 * A tool result as a hook sees it: the result body, before the log fields
 * the loop has not written yet.
 *
 * @public
 */
export type ToolResult = ToolResultBody;

/**
 * What a context provider, a skill and a hook receive for one step. The loop
 * does not call them yet (P3-02, P3-04, P3-05), so nothing fills this in.
 *
 * @public
 */
export type StepContext = {
  sessionId: string;
  runId: string;
  /** The signed-in user. Opaque here. */
  principal: unknown;
  /** Where the user is, when the message has a page. */
  page?: { path: string; entityRef?: string };
  agentId: string;
};

/**
 * A run that has ended, as `onRunEnd` receives it. The loop does not call
 * that hook yet (P3-05).
 *
 * @public
 */
export type RunSummary = {
  runId: string;
  sessionId: string;
  status: RunStatus;
};

/**
 * Text added to the model input on every step (X-03). The length limit and
 * the built-in providers come later (P3-02).
 *
 * @public
 */
export interface ContextProvider {
  id: string;
  /** `undefined` adds nothing. */
  provide(ctx: StepContext): Promise<string | undefined>;
}

/**
 * A skill (X-04). The context gets `id` and `description` only. `load`
 * returns the whole text, and only `load_skill` calls it (P3-04).
 *
 * @public
 */
export interface Skill {
  id: string;
  /** One sentence, placed in the context. */
  description: string;
  load(ctx: StepContext): Promise<string>;
}

/**
 * What `beforeToolCall` may answer. It can keep the policy or make it
 * stricter. A result that turns `ask` into `continue` is ignored (P3-05);
 * the loop does not apply that rule yet.
 *
 * @public
 */
export type BeforeToolCallResult =
  | { action: 'continue' }
  | { action: 'ask' }
  | { action: 'deny'; reason: string };

/**
 * The four moments a hook can use (X-05). The loop does not call them yet
 * (P3-05).
 *
 * @public
 */
export interface Hooks {
  beforeModelCall(ctx: StepContext): Promise<void>;
  beforeToolCall(
    call: ToolCall,
    ctx: StepContext,
  ): Promise<BeforeToolCallResult>;
  afterToolCall(call: ToolCall, result: ToolResult): Promise<ToolResult>;
  onRunEnd(run: RunSummary): Promise<void>;
}

/** @public */
export type HookName = keyof Hooks;

/**
 * What a backend module can add (X-02). The implementation lives in the
 * backend plugin; modules receive it through `ai-chat-node`.
 *
 * @public
 */
export interface AiChatHarnessExtensionPoint {
  addAgent(agent: AgentDefinition): void;
  addContextProvider(provider: ContextProvider): void;
  addSkill(skill: Skill): void;
  addHook<K extends HookName>(name: K, hook: Hooks[K]): void;
  /** Registers a client for a model id. The loop still uses its own client (P3-07). */
  setModelClient(id: string, client: ModelClient): void;
}

/**
 * The registrations the loop will read. P3-01 stores them and passes them
 * in. The loop does not call them (P3-02, P3-04, P3-05, P3-07).
 *
 * @public
 */
export type Extensions = {
  readonly contextProviders: readonly ContextProvider[];
  readonly skills: readonly Skill[];
  readonly hooks: { readonly [K in HookName]: readonly Hooks[K][] };
  readonly modelClients: ReadonlyMap<string, ModelClient>;
};

/** No registrations. @public */
export function emptyExtensions(): Extensions {
  return {
    contextProviders: [],
    skills: [],
    hooks: {
      beforeModelCall: [],
      beforeToolCall: [],
      afterToolCall: [],
      onRunEnd: [],
    },
    modelClients: new Map(),
  };
}

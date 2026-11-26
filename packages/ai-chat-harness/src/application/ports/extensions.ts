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

import type { AgentDefinition, JsonObject, RunUsage } from '../../domain';
import type { ModelClient } from './ModelClient';
import type { CallContext, ToolOutput } from './ToolGateway';

/**
 * What `beforeModelCall` and `beforeToolCall` hooks (X-05), skills and context
 * providers (X-03) get about the step. Every call of one gets its own copy.
 *
 * @public
 */
export interface StepContext extends CallContext {
  /**
   * The user the run acts for, as the host gives it. The backend plugin gives
   * `{ userRef, ownershipRefs, credentials }`: the entity ref of the user, the
   * refs the user owns through, and the `BackstageCredentials` of the request
   * that started or carried on the run, so a hook can check a permission or
   * call another plugin as the user. It is a copy for this call of the hook
   * only: do not keep it or use it after the hook returned.
   */
  principal: unknown;
  /** The id of the agent of the run. */
  agentId: string;
  /** 1-based step number about to run inside the current run. */
  step: number;
  /**
   * Aborts when the run stops, and for a context provider also when its time
   * is up. The loop stops waiting for the call then.
   */
  signal: AbortSignal;
}

/**
 * A copy of a validated tool call, as hooks get it (X-05). Changing it does
 * not change the call that is stored or the call the tool gateway runs.
 *
 * @public
 */
export interface ToolCall {
  /** The id of the call, the same as in the stored `tool_call` item. */
  readonly callId: string;
  /** The id of the tool, for example an action id. */
  readonly toolId: string;
  /** The input the model gave, after the schema check. */
  readonly input: JsonObject;
  /** Whether the tool is read-only. */
  readonly readOnly: boolean;
  /** The step of the run the call was made in. */
  readonly step: number;
  /** The place of the call among the calls of its step. */
  readonly position: number;
}

/**
 * What a tool gave back, as `afterToolCall` hooks get and return it (X-05).
 *
 * @public
 */
export type ToolResult = ToolOutput;

/**
 * What a `beforeToolCall` hook decides (X-05). `continue` keeps the policy,
 * `ask` makes the call wait for an approval, and `deny` refuses the call with
 * the reason. A hook can only keep or tighten the policy: `continue` never
 * runs a call that the policy asks an approval for.
 *
 * @public
 */
export type BeforeToolCallDecision =
  | { action: 'continue' }
  | { action: 'ask' }
  | { action: 'deny'; reason: string };

/**
 * What `onRunEnd` hooks get when a run ended (X-05): the status and usage the
 * host stored. It has the entity ref of the user and no credentials.
 *
 * @public
 */
export interface RunSummary {
  /** The session of the run. */
  readonly sessionId: string;
  /** The id of the run. */
  readonly runId: string;
  /** The id of the agent of the run. */
  readonly agentId: string;
  /** The entity ref of the user the run acted for. */
  readonly userRef: string;
  /** The status the run ended with. */
  readonly status: 'completed' | 'failed' | 'cancelled' | 'expired';
  /**
   * Why the run ended, as stored: for example a limit (`max_steps`), `user`
   * for a stop, `error`, or `shutdown`.
   */
  readonly endReason?: string;
  /** What the run used. */
  readonly usage: RunUsage;
}

/**
 * The hooks a backend module can register with `addHook` (X-05). Each hook
 * may return its value or a promise of it. Hooks of one kind run in the order
 * they were registered.
 *
 * The hooks fail closed: a hook that throws, or returns a value of the wrong
 * shape, never lets more happen than without it.
 *
 * @public
 */
export interface Hooks {
  /**
   * Runs before each call of the model of a step; a summary is not a step.
   * When it throws, the model is not called and the run ends `failed`.
   */
  beforeModelCall(ctx: StepContext): void | Promise<void>;
  /**
   * Runs for each tool call after the schema check, the limits and the policy
   * of the administrator. When it throws or returns a decision of the wrong
   * shape, the call is denied and the run goes on.
   */
  beforeToolCall(
    call: ToolCall,
    ctx: StepContext,
  ): BeforeToolCallDecision | Promise<BeforeToolCallDecision>;
  /**
   * Runs after a tool ran, and may change the result that is stored and
   * streamed. Each hook gets the result of the hook before it. It gets no
   * signal: when the run stops while it runs, the loop stops waiting and
   * stores an error result. When it throws or returns a result of the wrong
   * shape, the result is an error, without the output of the tool.
   */
  afterToolCall(
    call: ToolCall,
    result: ToolResult,
  ): ToolResult | Promise<ToolResult>;
  /**
   * Runs once after the host stored the end of a run, also when it was
   * stopped, failed or expired; not when it waits for an approval, and not
   * for a run that ended before its loop started. The run does not wait for
   * it, and a failure does not change the run. The backend plugin waits at
   * most 10 seconds for each hook, and at its shutdown at most 10 seconds
   * for the hooks that still run.
   */
  onRunEnd(run: RunSummary): void | Promise<void>;
}

/**
 * Names of lifecycle hooks supported by the harness extension point (X-05).
 *
 * @public
 */
export type HookName = keyof Hooks;

/**
 * Ordered hooks grouped by lifecycle phase.
 *
 * @public
 */
export type HookRegistry = {
  readonly [K in HookName]: readonly Hooks[K][];
};

/**
 * A reusable instruction set whose name and short description are shown in
 * context and whose full body is loaded lazily via `load_skill` (X-04, D-22).
 *
 * @public
 */
export interface Skill {
  id: string;
  /** One-line summary placed in the step context. */
  description: string;
  /** Returns the full Markdown instructions when the model calls `load_skill`. */
  load(ctx: StepContext): string | Promise<string>;
}

/**
 * A source of text that the loop adds to the context of every step (X-03).
 *
 * The loop calls `provide` before each model call, with a copy of the
 * `StepContext`, and waits for it at most `CONTEXT_PROVIDER_TIMEOUT_MS`. The
 * text is cut to `CONTEXT_PROVIDER_MAX_CHARS`, and is given to the model as
 * untrusted data, not as instructions. `undefined` or blank text adds
 * nothing. When `provide` throws, times out or returns something else than a
 * string, the step goes on and the model is told that this context is not
 * available.
 *
 * @public
 */
export interface ContextProvider {
  /** Names the text in the context; unique among the providers. */
  id: string;
  /** The text for the context of the step of `ctx`, or `undefined` for none. */
  provide(ctx: StepContext): string | undefined | Promise<string | undefined>;
}

/**
 * What a backend module can add (X-02).
 *
 * @public
 */
export interface AiChatHarnessExtensionPoint {
  addAgent(agent: AgentDefinition): void;
  /**
   * Adds the client of the model `id` (X-09). An agent names it with its
   * `model`. It adds a model and never replaces one: an id that the
   * configuration has (`default`, or a key of `aiChat.models`) or that was
   * added before stops the backend.
   */
  addModelClient(id: string, client: ModelClient): void;
  /**
   * Adds a hook of the kind `name`. An unknown name, or a hook that is not a
   * function, stops the backend.
   */
  addHook<K extends HookName>(name: K, hook: Hooks[K]): void;
  addSkill(skill: Skill): void;
  /**
   * Adds a context provider. A repeated or reserved id, or a provider of the
   * wrong shape, stops the backend.
   */
  addContextProvider(provider: ContextProvider): void;
}

/**
 * The registrations the loop reads from backend modules. The loop calls
 * `beforeModelCall`, `beforeToolCall` and `afterToolCall` and the context
 * providers, and lists the skills; the host calls `onRunEnd`, once it stored the end of the run.
 *
 * @public
 */
export type Extensions = {
  readonly hooks?: Partial<HookRegistry>;
  readonly skills?: readonly Skill[];
  /** Called at every step, in this order. */
  readonly contextProviders?: readonly ContextProvider[];
};

/** No registrations. @public */
export function emptyExtensions(): Extensions {
  return {
    hooks: {
      beforeModelCall: [],
      beforeToolCall: [],
      afterToolCall: [],
      onRunEnd: [],
    },
  };
}

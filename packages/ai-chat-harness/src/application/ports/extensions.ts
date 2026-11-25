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
import type { RunOutcome } from '../events';
import type { CallContext, ToolOutput } from './ToolGateway';

/**
 * Context passed to `beforeModelCall` and `beforeToolCall` hooks (X-05).
 *
 * @public
 */
export interface StepContext extends CallContext {
  agentId: string;
  /** 1-based step number about to run inside the current run. */
  step: number;
  signal: AbortSignal;
}

/**
 * Snapshot of a validated tool call passed to hooks (X-05). Mutating it does
 * not alter the call stored in the log or passed to the tool gateway.
 *
 * @public
 */
export interface ToolCall {
  readonly callId: string;
  readonly toolId: string;
  readonly input: JsonObject;
  readonly readOnly: boolean;
  readonly step: number;
  readonly position: number;
}

/**
 * Result returned or transformed by `afterToolCall` hooks (X-05).
 *
 * @public
 */
export type ToolResult = ToolOutput;

/**
 * Policy decision returned by a `beforeToolCall` hook (X-05). Hooks may keep
 * or tighten the policy (`ask` or `deny`), never relax `ask` to `continue`.
 *
 * @public
 */
export type BeforeToolCallDecision =
  | { action: 'continue' }
  | { action: 'ask' }
  | { action: 'deny'; reason: string };

/**
 * Summary passed to `onRunEnd` hooks when a run finishes terminally (X-05).
 *
 * @public
 */
export interface RunSummary {
  readonly sessionId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly principal: unknown;
  readonly outcome: RunOutcome;
  readonly usage: RunUsage;
}

/**
 * Lifecycle hooks a backend module may register through `addHook` (X-05).
 *
 * @public
 */
export interface Hooks {
  beforeModelCall(ctx: StepContext): void | Promise<void>;
  beforeToolCall(
    call: ToolCall,
    ctx: StepContext,
  ): BeforeToolCallDecision | Promise<BeforeToolCallDecision>;
  afterToolCall(
    call: ToolCall,
    result: ToolResult,
  ): ToolResult | Promise<ToolResult>;
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
 * What a backend module can add (X-02). Context providers (P3-02), skills
 * (P3-04) and a model client (P3-07) are added on those later items, together
 * with the loop calling them.
 *
 * @public
 */
export interface AiChatHarnessExtensionPoint {
  addAgent(agent: AgentDefinition): void;
  addHook<K extends HookName>(name: K, hook: Hooks[K]): void;
}

/**
 * The registrations the loop reads from backend modules.
 *
 * @public
 */
export type Extensions = {
  readonly hooks?: Partial<HookRegistry>;
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

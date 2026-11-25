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

import type { JsonObject, ToolCallItem } from '../../domain';
import type {
  Extensions,
  RunSummary,
  StepContext,
  ToolCall,
  ToolResult,
} from '../ports/extensions';
import type { AdvanceRunRequest } from '../types';

const HOOK_DENY_REASON = 'Denied by hook.';
const AFTER_HOOK_ERROR_MESSAGE = 'A hook failed after the tool call.';
const VALID_RESULT_STATUSES = new Set(['ok', 'error', 'timeout']);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function stepContextOf(
  req: AdvanceRunRequest,
  step: number,
): StepContext {
  return {
    sessionId: req.ctx.sessionId,
    runId: req.ctx.runId,
    principal: req.ctx.principal,
    ...(req.ctx.page ? { page: { ...req.ctx.page } } : {}),
    agentId: req.agent.id,
    step,
    signal: req.signal,
  };
}

export function toolCallFromParts(parts: {
  callId: string;
  toolId: string;
  input: JsonObject;
  readOnly: boolean;
  step: number;
  position: number;
}): ToolCall {
  return {
    callId: parts.callId,
    toolId: parts.toolId,
    input: cloneJson(parts.input),
    readOnly: parts.readOnly,
    step: parts.step,
    position: parts.position,
  };
}

export function toolCallFromItem(call: ToolCallItem): ToolCall {
  return toolCallFromParts({
    callId: call.callId,
    toolId: call.toolId,
    input: call.input,
    readOnly: call.readOnly,
    step: call.step,
    position: call.position,
  });
}

function cloneToolResult(result: ToolResult): ToolResult {
  return {
    status: result.status,
    ...(result.output !== undefined
      ? { output: cloneJson(result.output) }
      : {}),
    ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

function isValidToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.status !== 'string' ||
    !VALID_RESULT_STATUSES.has(candidate.status)
  ) {
    return false;
  }
  if (
    candidate.truncated !== undefined &&
    typeof candidate.truncated !== 'boolean'
  ) {
    return false;
  }
  if (
    candidate.message !== undefined &&
    typeof candidate.message !== 'string'
  ) {
    return false;
  }
  return true;
}

/**
 * Runs `beforeModelCall` hooks sequentially before a model step (X-05).
 * Failing closed stops the step before the model is called.
 */
export async function runBeforeModelCall(
  extensions: Extensions,
  ctx: StepContext,
): Promise<{ ok: true } | { ok: false; aborted?: true; error?: unknown }> {
  const list = extensions.hooks?.beforeModelCall ?? [];
  for (const hook of list) {
    if (ctx.signal.aborted) {
      return { ok: false, aborted: true };
    }
    try {
      await hook(ctx);
      if (ctx.signal.aborted) {
        return { ok: false, aborted: true };
      }
    } catch (error) {
      if (ctx.signal.aborted) {
        return { ok: false, aborted: true };
      }
      return { ok: false, error };
    }
  }
  return { ok: true };
}

/**
 * Runs `beforeToolCall` hooks monotonically (X-05): policies can tighten from
 * `allow` to `ask` or `deny`, or fail closed to `deny`, never relax `ask`.
 */
export async function runBeforeToolCall(
  extensions: Extensions,
  call: ToolCall,
  initialPolicy: 'allow' | 'ask',
  ctx: StepContext,
): Promise<
  | { aborted: true }
  | { aborted?: false; action: 'allow' | 'ask' }
  | { aborted?: false; action: 'deny'; reason: string }
> {
  let effective: 'allow' | 'ask' = initialPolicy;
  const list = extensions.hooks?.beforeToolCall ?? [];
  for (const hook of list) {
    if (ctx.signal.aborted) {
      return { aborted: true };
    }
    try {
      const decision = await hook(toolCallFromParts(call), ctx);
      if (ctx.signal.aborted) {
        return { aborted: true };
      }
      if (!decision || typeof decision !== 'object') {
        return { action: 'deny', reason: HOOK_DENY_REASON };
      }
      if (decision.action === 'deny') {
        const reason =
          typeof decision.reason === 'string' &&
          decision.reason.trim().length > 0
            ? decision.reason
            : HOOK_DENY_REASON;
        return { action: 'deny', reason };
      }
      if (decision.action === 'ask') {
        effective = 'ask';
      } else if (decision.action !== 'continue') {
        return { action: 'deny', reason: HOOK_DENY_REASON };
      }
    } catch {
      if (ctx.signal.aborted) {
        return { aborted: true };
      }
      return { action: 'deny', reason: HOOK_DENY_REASON };
    }
  }
  return { action: effective };
}

/**
 * Pipelines `afterToolCall` hooks sequentially after a tool executed (X-05).
 * Any exception or malformed result fails closed without keeping prior output.
 */
export async function runAfterToolCall(
  extensions: Extensions,
  call: ToolCallItem,
  initial: ToolResult,
  signal: AbortSignal,
): Promise<ToolResult | undefined> {
  let current = cloneToolResult(initial);
  const list = extensions.hooks?.afterToolCall ?? [];
  for (const hook of list) {
    if (signal.aborted) {
      return undefined;
    }
    try {
      const next = await hook(toolCallFromItem(call), cloneToolResult(current));
      if (signal.aborted) {
        return undefined;
      }
      if (!isValidToolResult(next)) {
        return { status: 'error', message: AFTER_HOOK_ERROR_MESSAGE };
      }
      current = cloneToolResult(next);
    } catch {
      if (signal.aborted) {
        return undefined;
      }
      return { status: 'error', message: AFTER_HOOK_ERROR_MESSAGE };
    }
  }
  return current;
}

/**
 * Runs `onRunEnd` hooks sequentially after a terminal run outcome (X-05).
 * Failures are isolated per hook so later hooks still execute.
 */
export async function runOnRunEnd(
  extensions: Extensions,
  summary: RunSummary,
): Promise<void> {
  const list = extensions.hooks?.onRunEnd ?? [];
  for (const hook of list) {
    try {
      await hook({
        ...summary,
        outcome: { ...summary.outcome },
        usage: { ...summary.usage },
      });
    } catch {
      // Errors in `onRunEnd` are isolated from later hooks and run state.
    }
  }
}

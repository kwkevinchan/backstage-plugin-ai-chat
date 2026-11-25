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
  StepContext,
  ToolCall,
  ToolResult,
} from '../ports/extensions';
import { copyStepContext } from './stepContext';

const HOOK_DENY_REASON = 'Denied by hook.';
const AFTER_HOOK_ERROR_MESSAGE = 'A hook failed after the tool call.';
const VALID_RESULT_STATUSES = new Set(['ok', 'error', 'timeout']);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

type Settled<T> =
  | { aborted: true }
  | { aborted: false; ok: true; value: T }
  | { aborted: false; ok: false; error: unknown };

/**
 * Calls the hook and waits for it, or for the signal, whichever comes first.
 * A hook that never answers must not keep the run (and its lease) going after
 * a stop or a timeout. The hook itself may still finish; what it returns then
 * is ignored.
 */
function settle<T>(
  call: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<Settled<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise<Settled<T>>(resolve => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    new Promise<T>(inner => inner(call()))
      .then(
        value =>
          resolve(
            signal.aborted
              ? { aborted: true }
              : { aborted: false, ok: true, value },
          ),
        error =>
          resolve(
            signal.aborted
              ? { aborted: true }
              : { aborted: false, ok: false, error },
          ),
      )
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
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
    const settled = await settle(() => hook(copyStepContext(ctx)), ctx.signal);
    if (settled.aborted) return { ok: false, aborted: true };
    if (!settled.ok) return { ok: false, error: settled.error };
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
    const settled = await settle(
      () => hook(toolCallFromParts(call), copyStepContext(ctx)),
      ctx.signal,
    );
    if (settled.aborted) return { aborted: true };
    if (!settled.ok) return { action: 'deny', reason: HOOK_DENY_REASON };
    const decision: unknown = settled.value;
    if (!decision || typeof decision !== 'object') {
      return { action: 'deny', reason: HOOK_DENY_REASON };
    }
    const { action, reason } = decision as {
      action?: unknown;
      reason?: unknown;
    };
    if (action === 'deny') {
      return {
        action: 'deny',
        reason:
          typeof reason === 'string' && reason.trim().length > 0
            ? reason
            : HOOK_DENY_REASON,
      };
    }
    if (action === 'ask') {
      effective = 'ask';
    } else if (action !== 'continue') {
      return { action: 'deny', reason: HOOK_DENY_REASON };
    }
  }
  return { action: effective };
}

/**
 * Pipelines `afterToolCall` hooks sequentially after a tool executed (X-05).
 * Any exception or malformed result fails closed without keeping prior
 * output. The tool has run by now, so a stop while a hook runs gives an error
 * result too: the call keeps a result, and the output no hook let through is
 * not stored.
 */
export async function runAfterToolCall(
  extensions: Extensions,
  call: ToolCallItem,
  initial: ToolResult,
  signal: AbortSignal,
): Promise<ToolResult> {
  const list = extensions.hooks?.afterToolCall ?? [];
  let current = cloneToolResult(initial);
  for (const hook of list) {
    const input = current;
    const settled = await settle(
      () => hook(toolCallFromItem(call), cloneToolResult(input)),
      signal,
    );
    if (settled.aborted || !settled.ok || !isValidToolResult(settled.value)) {
      return { status: 'error', message: AFTER_HOOK_ERROR_MESSAGE };
    }
    current = cloneToolResult(settled.value);
  }
  return current;
}

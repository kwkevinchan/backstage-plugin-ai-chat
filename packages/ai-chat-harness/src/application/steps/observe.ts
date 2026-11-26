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

import type { Item, ToolCallItem } from '../../domain';
import type {
  ModelCallOutcome,
  ModelCallRecord,
  RunObserver,
  ToolCallRecord,
  ToolDeniedReason,
} from '../ports/RunObserver';
import type { AdvanceRunDeps, AdvanceRunRequest } from '../types';

/** The name of the reason the loop aborts its signal with at the deadline. */
export const DEADLINE_REASON_NAME = 'TimeoutError';

/** The reason of the abort at the deadline of the run. */
export function deadlineReason(): Error {
  const reason = new Error('The working time of the run is used up.');
  reason.name = DEADLINE_REASON_NAME;
  return reason;
}

/**
 * How a model call that the signal aborted ended: the deadline of the run, or
 * the user.
 */
export function abortedOutcome(signal: AbortSignal): ModelCallOutcome {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === DEADLINE_REASON_NAME
    ? 'timeout'
    : 'cancelled';
}

/** The HTTP status an error carries in `status`, if it has one. */
export function errorStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

/** The tokens of a `usage` chunk, or `undefined` when they are not counts. */
export function usageOf(chunk: {
  inputTokens: unknown;
  outputTokens: unknown;
}): { inputTokens: number; outputTokens: number } | undefined {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (!count(chunk.inputTokens) || !count(chunk.outputTokens)) return undefined;
  return {
    inputTokens: chunk.inputTokens as number,
    outputTokens: chunk.outputTokens as number,
  };
}

/**
 * Gives a record to the observer. What the observer throws is ignored: a
 * measurement never changes a run.
 */
function tell(
  observer: RunObserver | undefined,
  send: (observer: RunObserver) => void,
): void {
  if (!observer) return;
  try {
    send(observer);
  } catch {
    // The observer is the host's; its failure is not the run's.
  }
}

export function observeModelCall(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  record: Omit<ModelCallRecord, 'sessionId' | 'runId' | 'agentId' | 'modelId'>,
): void {
  tell(deps.observer, observer =>
    observer.modelCall({
      sessionId: req.ctx.sessionId,
      runId: req.fence.runId,
      agentId: req.agent.id,
      ...(req.modelId !== undefined && { modelId: req.modelId }),
      ...record,
    }),
  );
}

/** What the loop knows of a result besides the item: why it was denied, how long it ran. */
export type ResultMeasure = {
  reason?: ToolDeniedReason;
  durationMs?: number;
};

/**
 * Gives the observer one record for each `tool_result` among `written`, with
 * the call it answers.
 */
export function observeResults(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  written: readonly Item[],
  callOf: (
    callId: string,
  ) =>
    | Pick<ToolCallItem, 'step' | 'position' | 'toolId' | 'readOnly'>
    | undefined,
  measureOf: (callId: string) => ResultMeasure | undefined,
): void {
  if (!deps.observer) return;
  for (const item of written) {
    if (item.kind !== 'tool_result') continue;
    const call = callOf(item.callId);
    if (!call) continue;
    const measure = measureOf(item.callId);
    const record: ToolCallRecord = {
      sessionId: req.ctx.sessionId,
      runId: req.fence.runId,
      agentId: req.agent.id,
      step: call.step,
      position: call.position,
      callId: item.callId,
      toolId: call.toolId,
      readOnly: call.readOnly === true,
      status: item.status,
      ...(item.status === 'denied' &&
        measure?.reason !== undefined && { reason: measure.reason }),
      ...(measure?.durationMs !== undefined && {
        durationMs: measure.durationMs,
      }),
      ...(item.truncated !== undefined && { truncated: item.truncated }),
    };
    tell(deps.observer, observer => observer.toolCall(record));
  }
}

/** Milliseconds from `start` to now, by the clock of the loop. */
export function msSince(deps: AdvanceRunDeps, start: number): number {
  return Math.max(0, deps.clock.now().getTime() - start);
}

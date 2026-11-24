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

import type { Item, ToolCallItem } from './item';
import type { Limits } from './agent';
import { needsApproval } from './policy';
import type { RunUsage } from './run';

/** @public */
export type StopReason = 'max_steps' | 'max_tool_calls' | 'timeout';

/**
 * What the loop does next.
 *
 * - `execute_tools`: `calls` run now (a call the user denied is in `calls`
 *   too; running it means writing a `denied` result). `interrupted` calls
 *   started before and have no result; they are not run again and get an
 *   `unknown` result.
 * - `wait_approval`: `pending` are the calls that wait for a decision.
 * - `stop`: a limit is reached.
 *
 * @public
 */
export type NextAction =
  | { type: 'call_model' }
  | {
      type: 'execute_tools';
      calls: ToolCallItem[];
      interrupted: ToolCallItem[];
    }
  | { type: 'wait_approval'; pending: ToolCallItem[] }
  | { type: 'complete' }
  | { type: 'stop'; reason: StopReason };

/**
 * Works out the next step from the log alone (D-18), so any backend can
 * continue a run. The rules, first match wins:
 *
 * 1. The last conversation item is an `agent_message` and no call of the last
 *    step is open: `complete`.
 * 2. The working time is used up: `stop`.
 * 3. A call of the last step needs approval, has no decision and has no
 *    result: `wait_approval`. A call needs approval when its policy is `ask`,
 *    or when it is not read-only whatever its policy says (D-06). Nothing of
 *    that step runs before every such call has a decision (P-04).
 * 4. A call of the last step has no result: `execute_tools`. A call with a
 *    `tool_started` item and no result goes to `interrupted` (D-25, A-08).
 * 5. Anything else (the last item is the user's message, or every result is
 *    in): `call_model`, unless the steps or the tool calls of the run are
 *    used up, then `stop`.
 *
 * The step and tool call limits stop a new model call only. They never leave
 * the calls of the last step without a result.
 *
 * @public
 */
export function decideNextAction(
  items: readonly Item[],
  run: RunUsage,
  limits: Limits,
): NextAction {
  const calls = callsOfLastStep(items);
  const withResult = new Set<string>();
  const decided = new Set<string>();
  const started = new Set<string>();
  for (const item of items) {
    if (item.kind === 'tool_result') withResult.add(item.callId);
    else if (item.kind === 'approval') decided.add(item.callId);
    else if (item.kind === 'tool_started') started.add(item.callId);
  }
  const open = calls.filter(call => !withResult.has(call.callId));

  if (lastFlowItem(items)?.kind === 'agent_message' && open.length === 0) {
    return { type: 'complete' };
  }
  if (run.elapsedSeconds >= limits.runTimeoutSeconds) {
    return { type: 'stop', reason: 'timeout' };
  }

  const pending = open.filter(
    call => needsApproval(call) && !decided.has(call.callId),
  );
  if (pending.length > 0) {
    return { type: 'wait_approval', pending };
  }
  if (open.length > 0) {
    return {
      type: 'execute_tools',
      calls: open.filter(call => !started.has(call.callId)),
      interrupted: open.filter(call => started.has(call.callId)),
    };
  }

  if (run.stepsUsed >= limits.maxSteps) {
    return { type: 'stop', reason: 'max_steps' };
  }
  if (run.toolCallsUsed >= limits.maxToolCallsPerRun) {
    return { type: 'stop', reason: 'max_tool_calls' };
  }
  return { type: 'call_model' };
}

/**
 * The decision of the user about a call, or `undefined` when there is none.
 *
 * @public
 */
export function decisionOf(
  items: readonly Item[],
  callId: string,
): 'allow' | 'deny' | undefined {
  for (const item of items) {
    if (item.kind === 'approval' && item.callId === callId) {
      return item.decision;
    }
  }
  return undefined;
}

/**
 * The last item of the conversation: a message of the user or the model, a
 * tool call or a tool result. Approvals, starts, plans, notes and summaries
 * are written beside the conversation and do not change what comes next.
 */
function lastFlowItem(items: readonly Item[]): Item | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i].kind;
    if (
      kind === 'user_message' ||
      kind === 'agent_message' ||
      kind === 'tool_call' ||
      kind === 'tool_result'
    ) {
      return items[i];
    }
  }
  return undefined;
}

/**
 * The calls of the newest step since the last message of the user, in the
 * order of their position. The newest step is the one of the last `tool_call`
 * in the log, in its run: two runs can follow one message of the user (for
 * example a run that expired and a resend), and step numbers start again in
 * each run. Calls of older steps have their results or are closed when the
 * model input is built.
 */
function callsOfLastStep(items: readonly Item[]): ToolCallItem[] {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user_message') {
      start = i + 1;
      break;
    }
  }
  const calls: ToolCallItem[] = [];
  for (let i = start; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'tool_call') calls.push(item);
  }
  const last = calls[calls.length - 1];
  if (!last) return calls;
  return calls
    .filter(call => call.step === last.step && call.runId === last.runId)
    .sort((a, b) => a.position - b.position);
}

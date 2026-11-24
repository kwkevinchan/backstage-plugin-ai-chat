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

import {
  needsApproval,
  type Item,
  type ToolCallItem,
} from '@kwkevinchan/ai-chat-harness';

/** The tool call with this id, if the log has it. */
export function findToolCall(
  items: readonly Item[],
  callId: string,
): ToolCallItem | undefined {
  return items.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' && item.callId === callId,
  );
}

/** Whether the call has a result: it ran, or it was closed without running. */
export function hasResult(items: readonly Item[], callId: string): boolean {
  return items.some(
    item => item.kind === 'tool_result' && item.callId === callId,
  );
}

/**
 * The calls of a run that wait for a decision of the user: they need approval
 * (the rule of the core, `needsApproval`), have no decision and no result. A
 * run that waits for an approval has such calls only in its last step, and
 * nothing of that step runs before all of them are decided (P-04).
 */
export function callsAwaitingDecision(
  items: readonly Item[],
  runId: string,
): ToolCallItem[] {
  const decided = new Set<string>();
  const closed = new Set<string>();
  for (const item of items) {
    if (item.kind === 'approval') decided.add(item.callId);
    else if (item.kind === 'tool_result') closed.add(item.callId);
  }
  return items.filter(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' &&
      item.runId === runId &&
      needsApproval(item) &&
      !decided.has(item.callId) &&
      !closed.has(item.callId),
  );
}

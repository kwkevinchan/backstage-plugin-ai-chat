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

import { isToolUIPart } from 'ai';
import type { ChatUiMessage, ToolPart } from './types';

function lastAssistant(messages: readonly ChatUiMessage[]) {
  const last = messages[messages.length - 1];
  return last?.role === 'assistant' ? last : undefined;
}

/** The tool parts of the last step of the last message, if it is the agent's. */
export function lastStepTools(messages: readonly ChatUiMessage[]): ToolPart[] {
  const message = lastAssistant(messages);
  if (!message) return [];
  const stepStart = message.parts.reduce(
    (found, part, index) => (part.type === 'step-start' ? index : found),
    -1,
  );
  return message.parts.slice(stepStart + 1).filter(isToolUIPart) as ToolPart[];
}

/** The ids of the calls that wait for the decision of the user. */
export function awaitingCalls(messages: readonly ChatUiMessage[]): string[] {
  return lastStepTools(messages)
    .filter(part => part.state === 'approval-requested')
    .map(part => part.toolCallId);
}

/**
 * Whether the decision for `callId` is the last one that the run waits for.
 * Only then the response of the decision is the stream of the run.
 */
export function isLastDecision(
  messages: readonly ChatUiMessage[],
  callId: string,
): boolean {
  return awaitingCalls(messages).every(id => id === callId);
}

/** Whether a response is on its way or a call waits for the user. */
export function hasWaitingCall(messages: readonly ChatUiMessage[]): boolean {
  return awaitingCalls(messages).length > 0;
}

/** The ids of the calls that have a decision, in any step of any message. */
export function decidedCalls(messages: readonly ChatUiMessage[]): string[] {
  return messages
    .flatMap(message => message.parts)
    .filter(isToolUIPart)
    .filter(part => (part as ToolPart).approval?.approved !== undefined)
    .map(part => (part as ToolPart).toolCallId);
}

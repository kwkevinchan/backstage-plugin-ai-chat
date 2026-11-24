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
  messageIdOfRun,
  type ChatItem,
  type ChatPlan,
  type ChatSessionDetail,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { NOT_RUN, RESULT_NOT_KNOWN } from './toolView';
import type { ChatUiMessage } from './types';

type Part = ChatUiMessage['parts'][number];
type ToolItem = ChatItem & { kind: 'tool_call' };

/** The id of the message that shows a `user_message` item. */
export function userMessageId(seq: number): string {
  return `item_${seq}`;
}

/**
 * The messages of the screen for the stored items of a session (architecture,
 * "HTTP": restoring the screen from the log).
 *
 * - A `user_message` is a user message. The items of one run are one assistant
 *   message with the id of `messageIdOfRun`, the id that the response streams
 *   of the run use, so a stream continues it.
 * - A call is shown by its last item. A call that waits for the user
 *   (`awaitingDecision`) is `approval-requested`; one that was decided while
 *   the run goes on is `approval-responded`. Both carry `approval.id` equal to
 *   the call id: the stream names the part of a decision by it.
 * - The run that has not ended is `detail.run`. A call of any other run that
 *   has no result did not finish: it shows as unknown when `tool_started` is
 *   stored (it may have run), otherwise as not run.
 * - `summary`, `note` and `tool_started` items are not messages.
 */
export function itemsToMessages(
  detail: Pick<ChatSessionDetail, 'items' | 'run' | 'awaitingDecision'>,
): ChatUiMessage[] {
  const { items, run } = detail;
  const awaiting = new Set(detail.awaitingDecision);
  const decisions = new Map<string, boolean>();
  const started = new Set<string>();
  const results = new Map<string, ChatItem & { kind: 'tool_result' }>();
  for (const item of items) {
    if (item.kind === 'approval') {
      decisions.set(item.callId, item.decision === 'allow');
    } else if (item.kind === 'tool_started') {
      started.add(item.callId);
    } else if (item.kind === 'tool_result') {
      results.set(item.callId, item);
    }
  }

  const toolPart = (call: ToolItem): Part => {
    const base = {
      type: `tool-${call.toolId}`,
      toolCallId: call.callId,
      input: call.input,
    };
    const result = results.get(call.callId);
    const decided = decisions.get(call.callId);
    if (result) {
      switch (result.status) {
        case 'ok':
          return {
            ...base,
            state: 'output-available',
            output: result.output ?? null,
            ...(decided === true && {
              approval: { id: call.callId, approved: true },
            }),
          } as Part;
        case 'denied':
          return {
            ...base,
            state: 'output-denied',
            approval: { id: call.callId, approved: false },
          } as Part;
        case 'unknown':
          return {
            ...base,
            state: 'output-error',
            errorText: RESULT_NOT_KNOWN,
          } as Part;
        default:
          return {
            ...base,
            state: 'output-error',
            errorText: result.message ?? 'The tool call failed.',
            ...(decided === true && {
              approval: { id: call.callId, approved: true },
            }),
          } as Part;
      }
    }
    if (run && call.runId === run.id) {
      if (awaiting.has(call.callId)) {
        return {
          ...base,
          state: 'approval-requested',
          approval: { id: call.callId },
        } as Part;
      }
      if (decided !== undefined) {
        return {
          ...base,
          state: 'approval-responded',
          approval: { id: call.callId, approved: decided },
        } as Part;
      }
      return { ...base, state: 'input-available' } as Part;
    }
    return {
      ...base,
      state: 'output-error',
      errorText: started.has(call.callId) ? RESULT_NOT_KNOWN : NOT_RUN,
    } as Part;
  };

  const messages: ChatUiMessage[] = [];
  const assistant = new Map<string, ChatUiMessage>();
  /** Whether the next text or call begins a new step of its run. */
  const newStep = new Set<string>();
  const plans = new Map<string, ChatPlan>();

  for (const item of items) {
    if (item.kind === 'user_message') {
      messages.push({
        id: userMessageId(item.seq),
        role: 'user',
        parts: [{ type: 'text', text: item.text }],
      });
      continue;
    }
    if (!item.runId) continue;
    let message = assistant.get(item.runId);
    if (!message) {
      message = {
        id: messageIdOfRun(item.runId),
        role: 'assistant',
        parts: [],
      };
      assistant.set(item.runId, message);
      messages.push(message);
      newStep.add(item.runId);
    }
    const beginStep = () => {
      if (newStep.delete(item.runId!)) {
        message!.parts.push({ type: 'step-start' });
      }
    };
    switch (item.kind) {
      case 'agent_message':
        beginStep();
        message.parts.push({ type: 'text', text: item.text, state: 'done' });
        break;
      case 'tool_call':
        beginStep();
        message.parts.push(toolPart(item));
        break;
      case 'approval':
      case 'tool_started':
      case 'tool_result':
        newStep.add(item.runId);
        break;
      case 'plan_update':
        plans.set(item.runId, item.plan);
        break;
      default:
        break;
    }
  }
  for (const [runId, plan] of plans) {
    assistant
      .get(runId)
      ?.parts.push({ type: 'data-plan', id: 'plan', data: plan });
  }
  return messages;
}

/**
 * Whether the last run of the session stopped before it gave an answer: no
 * run is active, and the log does not end with a message of the agent. The run
 * expired, was cancelled or failed; the user can send the message again.
 */
export function lastRunInterrupted(
  detail: Pick<ChatSessionDetail, 'items' | 'run'>,
): boolean {
  if (detail.run) return false;
  for (let i = detail.items.length - 1; i >= 0; i--) {
    switch (detail.items[i].kind) {
      case 'agent_message':
        return false;
      case 'user_message':
      case 'tool_call':
      case 'approval':
      case 'tool_started':
      case 'tool_result':
        return true;
      default:
        break;
    }
  }
  return false;
}

/** The text of the last message of the user, to send it again. */
export function lastUserText(items: readonly ChatItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'user_message') return item.text;
  }
  return undefined;
}

/** Who decided a call, and when. */
export type DecisionInfo = { by: string; at: string };

/** The decisions of the log by call id, as the `approval` items say. */
export function decisionsOf(
  items: readonly ChatItem[],
): Record<string, DecisionInfo> {
  const decisions: Record<string, DecisionInfo> = {};
  for (const item of items) {
    if (item.kind === 'approval') {
      decisions[item.callId] = { by: item.decidedBy, at: item.createdAt };
    }
  }
  return decisions;
}

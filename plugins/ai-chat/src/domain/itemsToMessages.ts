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
  type ChatAttachment,
  type ChatInsertState,
  type ChatItem,
  type ChatPlan,
  type ChatSessionDetail,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { NOT_RUN, RESULT_NOT_KNOWN } from './toolView';
import type { ChatUiMessage, OutgoingMessage } from './types';

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
 * - An inserted message (`delivery: inserted`) is shown by its `insertState`.
 *   `read`: a `data-inserted` part in the message of its run, before the step
 *   that read it (the first output whose `readUpToSeq` covers it), as the
 *   stream does. `pending`: not in the conversation (the screen shows it above
 *   the input box). `unread`: a user message with a `data-unread` part; it has
 *   its own `sendAgain` only when the run gave an answer (`lastRunInterrupted`
 *   is false, which has one button for the run), and only in the last run.
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
            approval: {
              id: call.callId,
              approved: decided ?? false,
              ...(result.deniedReason !== undefined && {
                reason: result.deniedReason,
              }),
            },
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

  const states = insertStatesOf(items, run);
  const insertedRead = items.filter(
    item => isInserted(item) && states.get(item.seq) === 'read',
  ) as InsertedItem[];
  let nextRead = 0;
  const interrupted = lastRunInterrupted(detail);
  const lastRunId = [...items].reverse().find(item => item.runId)?.runId;

  const messages: ChatUiMessage[] = [];
  const assistant = new Map<string, ChatUiMessage>();
  /** Whether the next text or call begins a new step of its run or turn. */
  const newStep = new Set<string>();
  const plans = new Map<string, ChatPlan>();
  let turn = 0;

  for (const item of items) {
    if (item.kind === 'user_message') {
      if (isInserted(item)) {
        const state = states.get(item.seq);
        if (state === 'unread') {
          messages.push({
            id: userMessageId(item.seq),
            role: 'user',
            ...messageMetadata(item.attachments),
            parts: [
              { type: 'text', text: item.text },
              {
                type: 'data-unread',
                id: `unread-${item.seq}`,
                data: {
                  seq: item.seq,
                  sendAgain:
                    !interrupted &&
                    item.runId !== undefined &&
                    item.runId === lastRunId,
                },
              },
            ],
          });
        }
        continue;
      }
      turn = item.seq;
      messages.push({
        id: userMessageId(item.seq),
        role: 'user',
        ...messageMetadata(item.attachments),
        parts: [{ type: 'text', text: item.text }],
      });
      continue;
    }
    if (item.kind === 'summary' || item.kind === 'note') continue;
    const key = item.runId ?? `turn-${turn}`;
    let message = assistant.get(key);
    if (!message) {
      message = {
        id: item.runId ? messageIdOfRun(item.runId) : `turn_${turn}`,
        role: 'assistant',
        parts: [],
      };
      assistant.set(key, message);
      messages.push(message);
      newStep.add(key);
    }
    if (
      (item.kind === 'agent_message' || item.kind === 'tool_call') &&
      item.readUpToSeq !== undefined
    ) {
      // The messages that this output read come before its step.
      while (
        nextRead < insertedRead.length &&
        insertedRead[nextRead].seq <= item.readUpToSeq
      ) {
        const read = insertedRead[nextRead++];
        message.parts.push({
          type: 'data-inserted',
          id: `inserted-${read.seq}`,
          data: {
            seq: read.seq,
            text: read.text,
            ...(read.page && { page: read.page }),
            ...(read.attachments &&
              read.attachments.length > 0 && {
                attachments: read.attachments,
              }),
          },
        });
        newStep.add(key);
      }
    }
    const beginStep = () => {
      if (newStep.delete(key)) {
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
        newStep.add(key);
        break;
      case 'plan_update':
        plans.set(key, item.plan);
        break;
      default:
        break;
    }
  }
  for (const [key, plan] of plans) {
    assistant
      .get(key)
      ?.parts.push({ type: 'data-plan', id: 'plan', data: plan });
  }
  return messages;
}

/** A message of the user that was inserted into a run that went on. */
type InsertedItem = ChatItem & { kind: 'user_message' };

function isInserted(item: ChatItem): boolean {
  return item.kind === 'user_message' && item.delivery === 'inserted';
}

/**
 * Whether the model read each inserted message, by `seq`. The backend says so
 * in `insertState`; for an item without it, an output of the log that has
 * read it (`readUpToSeq`) decides, and a message nobody read is `pending`
 * while its run goes on and `unread` after.
 */
function insertStatesOf(
  items: readonly ChatItem[],
  run: ChatSessionDetail['run'],
): Map<number, ChatInsertState> {
  const states = new Map<number, ChatInsertState>();
  for (const item of items) {
    if (!isInserted(item) || item.kind !== 'user_message') continue;
    if (item.insertState) {
      states.set(item.seq, item.insertState);
      continue;
    }
    const read = items.some(
      other =>
        (other.kind === 'agent_message' || other.kind === 'tool_call') &&
        other.readUpToSeq !== undefined &&
        other.readUpToSeq >= item.seq,
    );
    const goes = run !== undefined && run.id === item.runId;
    let state: ChatInsertState = 'unread';
    if (read) state = 'read';
    else if (goes) state = 'pending';
    states.set(item.seq, state);
  }
  return states;
}

/** The inserted messages that wait for the model to read them. */
export function pendingInserts(
  detail: Pick<ChatSessionDetail, 'items' | 'run'>,
): { seq: number; text: string; attachments?: ChatAttachment[] }[] {
  const states = insertStatesOf(detail.items, detail.run);
  return detail.items
    .filter(item => isInserted(item) && states.get(item.seq) === 'pending')
    .map(item => {
      const inserted = item as InsertedItem;
      return {
        seq: item.seq,
        text: inserted.text,
        ...(inserted.attachments &&
          inserted.attachments.length > 0 && {
            attachments: inserted.attachments,
          }),
      };
    });
}

/**
 * Whether the last run of the session stopped before it gave an answer: no
 * run is active, and the log does not end with a message of the agent. The run
 * expired, was cancelled or failed; the user can send the message again.
 * Inserted messages do not count: a run that ended with its answer and has an
 * unread inserted message after it is not interrupted, and sending its first
 * message again would ask the answered question once more.
 */
export function lastRunInterrupted(
  detail: Pick<ChatSessionDetail, 'items' | 'run'>,
): boolean {
  if (detail.run) return false;
  for (let i = detail.items.length - 1; i >= 0; i--) {
    const item = detail.items[i];
    switch (item.kind) {
      case 'agent_message':
        return false;
      case 'user_message':
        if (isInserted(item)) break;
        return true;
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

/**
 * The first message of the last run, to send it again: the last message of
 * the user that was not inserted into a run, text and images.
 */
export function lastUserDraft(
  items: readonly ChatItem[],
): OutgoingMessage | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'user_message' && !isInserted(item)) {
      return {
        text: item.text,
        ...(item.attachments &&
          item.attachments.length > 0 && { attachments: item.attachments }),
      };
    }
  }
  return undefined;
}

/** The text of {@link lastUserDraft}. */
export function lastUserText(items: readonly ChatItem[]): string | undefined {
  return lastUserDraft(items)?.text;
}

/** Metadata for a user message that has images. Omitted when it has none. */
function messageMetadata(attachments?: ChatAttachment[]) {
  return attachments && attachments.length > 0
    ? { metadata: { attachments } }
    : {};
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

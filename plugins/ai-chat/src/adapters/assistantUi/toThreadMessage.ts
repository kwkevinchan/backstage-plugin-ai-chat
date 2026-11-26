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
import type { ThreadMessageLike } from '@assistant-ui/react';
import { toolIdOf } from '../../domain/toolView';
import type { ChatUiMessage, ToolPart } from '../../domain/types';
import { toCompleteAttachment } from './attachmentAdapter';

type Part = Exclude<ThreadMessageLike['content'], string>[number];
type ToolCallLike = Extract<Part, { type: 'tool-call' }>;
type JsonObject = NonNullable<ToolCallLike['args']>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A tool part of the AI SDK as a tool call of assistant-ui.
 *
 * - `args` is the input; an input that is not an object yet (still streaming)
 *   is `{}`, and `argsText` has the input as JSON.
 * - `result` is the output. A failed call has `isError` and the error text as
 *   its result, so the card can tell a failure, an unknown result and a call
 *   that did not run apart.
 * - `approval` has the id that the decision answers and, once decided,
 *   `approved`.
 */
export function toToolCall(part: ToolPart): ToolCallLike {
  const toolName =
    part.type === 'dynamic-tool' ? part.toolName : toolIdOf(part);
  const input = part.input;
  const call: {
    -readonly [K in keyof ToolCallLike]: ToolCallLike[K];
  } = {
    type: 'tool-call',
    toolCallId: part.toolCallId,
    toolName,
    args: isObject(input) ? input : {},
    argsText: input === undefined ? '' : JSON.stringify(input),
  };
  if (part.state === 'output-available') {
    call.result = part.output;
  } else if (part.state === 'output-error') {
    call.result = part.errorText;
    call.isError = true;
  }
  if (part.approval) {
    call.approval = {
      id: part.approval.id,
      ...(part.approval.approved !== undefined && {
        approved: part.approval.approved,
      }),
      ...(part.approval.reason !== undefined && {
        reason: part.approval.reason,
      }),
    };
  }
  return call;
}

/**
 * A message of the chat as a message of assistant-ui. Text, tool calls and
 * the data parts (`data-inserted`, `data-unread`, `data-run`, `data-notice`
 * and the others) keep their order; a data part keeps its name and data.
 * Step boundaries, reasoning and files are left out: the screen does not
 * show them. The images of a user message (`metadata.attachments`) are its
 * attachments; they carry our attachment, not a URL.
 */
export function toThreadMessage(message: ChatUiMessage): ThreadMessageLike {
  const content: Part[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type.startsWith('data-')) {
      const data = part as {
        type: `data-${string}`;
        id?: string;
        data: unknown;
      };
      content.push({
        type: data.type,
        ...(data.id !== undefined && { id: data.id }),
        data: data.data,
      });
    } else if (isToolUIPart(part) && message.role === 'assistant') {
      content.push(toToolCall(part as ToolPart));
    }
  }
  const attachments =
    message.role === 'user' ? message.metadata?.attachments ?? [] : [];
  return {
    id: message.id,
    role: message.role,
    content,
    ...(attachments.length > 0 && {
      attachments: attachments.map(toCompleteAttachment),
    }),
  };
}

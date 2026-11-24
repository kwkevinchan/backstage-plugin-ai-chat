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

import type { JsonObject, JsonValue } from '@backstage/types';

/**
 * Who wrote a message that the chat shows.
 *
 * @public
 */
export type ChatRole = 'user' | 'assistant';

/**
 * Where a tool call is in its life.
 *
 * - `pending_approval`: the action is not read-only and waits for the owner of
 *   the conversation. It has not run.
 * - `approved`: the owner allowed it; the action is about to run.
 * - `rejected`: the owner refused it, or sent a new message instead
 *   (`error` is `superseded`). It did not run.
 * - `running`: the action runs now.
 * - `succeeded` and `failed`: the action ran (or could not be started) and
 *   `output` or `error` has the result.
 *
 * @public
 */
export type ChatToolCallStatus =
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'succeeded'
  | 'failed';

/**
 * The attributes of an action at the time of the call.
 *
 * @public
 */
export interface ChatActionAttributes {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
}

/** @public */
export interface ChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** @public */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

/**
 * The output of a call that was cut: `text` has the first part of the JSON
 * text of the output.
 *
 * @public
 */
export interface ChatCutOutput {
  truncated: true;
  originalLength: number;
  text: string;
}

/** @public */
export interface ChatToolCall {
  id: string;
  /** The assistant message that asked for the call. */
  messageId: string;
  /** The action ID in the actions registry, for example `catalog:get-catalog-entity`. */
  actionId: string;
  /** The title and description of the action when the call was made. */
  title: string;
  description: string;
  /** The exact input that runs when the call is allowed. */
  input: JsonObject;
  attributes: ChatActionAttributes;
  status: ChatToolCallStatus;
  output?: JsonValue | ChatCutOutput;
  error?: string;
  /** The user who allowed or rejected the call. */
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

/** @public */
export interface ChatConversationDetail {
  conversation: ChatConversation;
  messages: ChatMessage[];
  toolCalls: ChatToolCall[];
}

/**
 * The events of a response stream (`text/event-stream`). Each event has the
 * SSE event name `type` and the whole object as JSON in `data`.
 *
 * @public
 */
export type ChatEvent =
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'text_delta'; text: string }
  | { type: 'assistant_message'; message: ChatMessage }
  | { type: 'tool_call'; toolCall: ChatToolCall }
  | { type: 'tool_result'; toolCall: ChatToolCall }
  | { type: 'approval_required'; toolCall: ChatToolCall }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

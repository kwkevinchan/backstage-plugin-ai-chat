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

import { createApiRef } from '@backstage/core-plugin-api';
import type {
  ChatConversation,
  ChatConversationDetail,
  ChatEvent,
} from '../common';

/**
 * The API of the chat backend. The methods that answer with a stream return
 * the events as they arrive; the stream ends with a `done` event, or when
 * `signal` aborts.
 *
 * @public
 */
export interface AiChatApi {
  listConversations(): Promise<ChatConversation[]>;
  createConversation(): Promise<ChatConversation>;
  getConversation(id: string): Promise<ChatConversationDetail>;
  deleteConversation(id: string): Promise<void>;
  sendMessage(
    id: string,
    content: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent>;
  /** Allows a call that waits: the backend runs the stored input. */
  approveToolCall(
    id: string,
    callId: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent>;
  rejectToolCall(
    id: string,
    callId: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent>;
}

/**
 * The API reference of the chat backend client.
 *
 * @public
 */
export const aiChatApiRef = createApiRef<AiChatApi>({
  id: 'plugin.ai-chat.service',
});

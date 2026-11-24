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

import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { chatPaths } from '../common';
import type {
  ChatConversation,
  ChatConversationDetail,
  ChatEvent,
} from '../common';
import { bodyChunks, parseEventStream } from './sse';
import type { AiChatApi } from './types';

/** The client of the chat backend plugin, with the sign-in of the app. */
export class AiChatClient implements AiChatApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const baseUrl = await this.discoveryApi.getBaseUrl('ai-chat');
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`, init);
    if (!response.ok) throw await ResponseError.fromResponse(response);
    return response;
  }

  async listConversations(): Promise<ChatConversation[]> {
    const response = await this.request(chatPaths.conversations());
    return (await response.json()).items;
  }

  async createConversation(): Promise<ChatConversation> {
    const response = await this.request(chatPaths.conversations(), {
      method: 'POST',
    });
    return response.json();
  }

  async getConversation(id: string): Promise<ChatConversationDetail> {
    const response = await this.request(chatPaths.conversation(id));
    return response.json();
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request(chatPaths.conversation(id), { method: 'DELETE' });
  }

  sendMessage(id: string, content: string, signal?: AbortSignal) {
    return this.stream(chatPaths.messages(id), { content }, signal);
  }

  approveToolCall(id: string, callId: string, signal?: AbortSignal) {
    return this.stream(chatPaths.approve(id, callId), undefined, signal);
  }

  rejectToolCall(id: string, callId: string, signal?: AbortSignal) {
    return this.stream(chatPaths.reject(id, callId), undefined, signal);
  }

  private async *stream(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const response = await this.request(path, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.body) return;
    yield* parseEventStream(bodyChunks(response.body));
  }
}

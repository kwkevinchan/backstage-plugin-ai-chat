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
import {
  chatPaths,
  type ChatInputConfig,
  type ChatItem,
  type ChatQueue,
  type ChatQueuedMessage,
  type ChatSession,
  type ChatSessionDetail,
  type ChatTool,
  type ChatToolset,
  type ChatUploadedAttachment,
  type CreateChatSessionRequest,
  type DecideToolCallRequest,
  type InsertChatMessageRequest,
  type InsertQueuedMessageRequest,
  type QueueChatMessageRequest,
  type ReorderQueueRequest,
  type ResumeChatRunRequest,
  type SendChatMessageRequest,
  type UpdateChatSessionRequest,
  type UpdateQueuedMessageRequest,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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

  private post(path: string, body: unknown, signal?: AbortSignal) {
    return this.request(path, {
      method: 'POST',
      signal,
      headers: JSON_HEADERS,
      body: JSON.stringify(body ?? {}),
    });
  }

  async listSessions(options?: {
    query?: string;
    includeArchived?: boolean;
  }): Promise<ChatSession[]> {
    const params = new URLSearchParams();
    if (options?.query) params.set('q', options.query);
    if (options?.includeArchived) params.set('includeArchived', 'true');
    const search = params.toString();
    const response = await this.request(
      `${chatPaths.sessions()}${search ? `?${search}` : ''}`,
    );
    return (await response.json()).items;
  }

  async createSession(request?: CreateChatSessionRequest) {
    const response = await this.post(chatPaths.sessions(), request);
    return (await response.json()) as ChatSession;
  }

  async getSession(id: string) {
    const response = await this.request(chatPaths.session(id));
    return (await response.json()) as ChatSessionDetail;
  }

  async updateSession(id: string, request: UpdateChatSessionRequest) {
    const response = await this.request(chatPaths.session(id), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    return (await response.json()) as ChatSession;
  }

  async deleteSession(id: string): Promise<void> {
    await this.request(chatPaths.session(id), { method: 'DELETE' });
  }

  async listToolsets(): Promise<ChatToolset[]> {
    const response = await this.request(chatPaths.toolsets());
    return (await response.json()).items;
  }

  async listSessionTools(id: string): Promise<ChatTool[]> {
    const response = await this.request(chatPaths.tools(id));
    return (await response.json()).items;
  }

  sendMessage(
    id: string,
    request: SendChatMessageRequest,
    signal?: AbortSignal,
  ) {
    return this.post(chatPaths.runs(id), request, signal);
  }

  decide(
    id: string,
    callId: string,
    request: DecideToolCallRequest,
    signal?: AbortSignal,
  ) {
    return this.post(chatPaths.decision(id, callId), request, signal);
  }

  async resume(
    id: string,
    request: ResumeChatRunRequest,
    signal?: AbortSignal,
  ) {
    const response = await this.post(chatPaths.resume(id), request, signal);
    return response.status === 204 ? undefined : response;
  }

  async follow(id: string, signal?: AbortSignal) {
    const response = await this.request(chatPaths.stream(id), { signal });
    return response.status === 204 ? undefined : response;
  }

  async cancelRun(id: string, runId: string): Promise<void> {
    try {
      await this.post(chatPaths.cancelRun(id, runId), {});
    } catch (error) {
      // The run ended before the request arrived.
      if (error instanceof ResponseError && error.response.status === 409) {
        return;
      }
      throw error;
    }
  }

  async insertMessage(
    id: string,
    runId: string,
    request: InsertChatMessageRequest,
  ) {
    const response = await this.post(
      chatPaths.insertMessage(id, runId),
      request,
    );
    return (await response.json()) as ChatItem;
  }

  async getQueue(id: string) {
    const response = await this.request(chatPaths.queue(id));
    return (await response.json()) as ChatQueue;
  }

  async queueMessage(id: string, request: QueueChatMessageRequest) {
    const response = await this.post(chatPaths.queue(id), request);
    return (await response.json()) as ChatQueuedMessage;
  }

  async updateQueuedMessage(
    id: string,
    queuedId: string,
    request: UpdateQueuedMessageRequest,
  ) {
    const response = await this.request(chatPaths.queuedMessage(id, queuedId), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    return (await response.json()) as ChatQueuedMessage;
  }

  async deleteQueuedMessage(id: string, queuedId: string): Promise<void> {
    await this.request(chatPaths.queuedMessage(id, queuedId), {
      method: 'DELETE',
    });
  }

  async insertQueuedMessage(
    id: string,
    queuedId: string,
    request: InsertQueuedMessageRequest,
  ) {
    const response = await this.post(
      chatPaths.insertQueuedMessage(id, queuedId),
      request,
    );
    return (await response.json()) as ChatItem;
  }

  async reorderQueue(id: string, request: ReorderQueueRequest) {
    const response = await this.request(chatPaths.queueOrder(id), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    return (await response.json()) as ChatQueue;
  }

  async resumeQueue(id: string, signal?: AbortSignal) {
    const response = await this.post(chatPaths.queueResume(id), {}, signal);
    return response.status === 204 ? undefined : response;
  }

  async getInputConfig() {
    const response = await this.request(chatPaths.inputConfig());
    return (await response.json()) as ChatInputConfig;
  }

  async uploadAttachment(
    sessionId: string,
    body: Blob,
    name: string,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const total = body.size;
    onProgress?.(0, total);
    const response = await this.request(
      `${chatPaths.attachments(sessionId)}?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': body.type || 'application/octet-stream' },
        body,
      },
    );
    onProgress?.(total, total);
    return (await response.json()) as ChatUploadedAttachment;
  }

  async readAttachment(sessionId: string, attachmentId: string) {
    const response = await this.request(
      chatPaths.attachment(sessionId, attachmentId),
    );
    return response.blob();
  }
}

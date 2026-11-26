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
  ChatInputConfig,
  ChatItem,
  ChatQueue,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionDetail,
  ChatShare,
  ChatTool,
  ChatToolset,
  ChatUploadedAttachment,
  CreateChatSessionRequest,
  CreateChatShareRequest,
  DecideToolCallRequest,
  InsertChatMessageRequest,
  InsertQueuedMessageRequest,
  QueueChatMessageRequest,
  ReorderQueueRequest,
  ResumeChatRunRequest,
  SendChatMessageRequest,
  UpdateChatSessionRequest,
  UpdateChatShareRequest,
  UpdateQueuedMessageRequest,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';

/**
 * The API of the chat backend. A method that answers with a stream of a run
 * returns the response as it is, so the caller reads the body while it
 * arrives; a failed request throws.
 *
 * @public
 */
export interface AiChatApi {
  /** `entityRef` keeps the sessions bound to that entity. */
  listSessions(options?: {
    query?: string;
    includeArchived?: boolean;
    entityRef?: string;
  }): Promise<ChatSession[]>;
  createSession(request?: CreateChatSessionRequest): Promise<ChatSession>;
  getSession(id: string): Promise<ChatSessionDetail>;
  updateSession(
    id: string,
    request: UpdateChatSessionRequest,
  ): Promise<ChatSession>;
  deleteSession(id: string): Promise<void>;
  /** The shares of a session that are not cancelled; only its owner lists them. */
  listShares(id: string): Promise<ChatShare[]>;
  /** Shares a session, read-only, with a user or a group. */
  createShare(id: string, request: CreateChatShareRequest): Promise<ChatShare>;
  /** Changes a share; 404 when it is cancelled. */
  updateShare(
    id: string,
    shareId: string,
    request: UpdateChatShareRequest,
  ): Promise<ChatShare>;
  /** Cancels a share; 404 when it is cancelled already. */
  revokeShare(id: string, shareId: string): Promise<void>;
  listToolsets(): Promise<ChatToolset[]>;
  /** The tools the session offers now, to show a call with its title and what it does. */
  listSessionTools(id: string): Promise<ChatTool[]>;
  /** Starts a run: the response is its stream. */
  sendMessage(
    id: string,
    request: SendChatMessageRequest,
    signal?: AbortSignal,
  ): Promise<Response>;
  /**
   * Stores a decision. The response is JSON while other calls wait for a
   * decision, and the stream of the run when this was the last one.
   */
  decide(
    id: string,
    callId: string,
    request: DecideToolCallRequest,
    signal?: AbortSignal,
  ): Promise<Response>;
  /** Carries on a run whose decisions are all stored; `undefined` when there is nothing to carry on. */
  resume(
    id: string,
    request: ResumeChatRunRequest,
    signal?: AbortSignal,
  ): Promise<Response | undefined>;
  /** Follows the run that goes on; `undefined` when none does. */
  follow(id: string, signal?: AbortSignal): Promise<Response | undefined>;
  /** Asks the run to stop. A run that has ended is not an error. */
  cancelRun(id: string, runId: string): Promise<void>;
  /**
   * Adds a message to a run that goes on. Resolves with the stored item.
   * A run that is not `running` (any more) answers 409.
   */
  insertMessage(
    id: string,
    runId: string,
    request: InsertChatMessageRequest,
  ): Promise<ChatItem>;
  /** The messages that wait for the run to end. */
  getQueue(id: string): Promise<ChatQueue>;
  /** Queues a message while a run goes on; 409 when no run goes on or the queue is full. */
  queueMessage(
    id: string,
    request: QueueChatMessageRequest,
  ): Promise<ChatQueuedMessage>;
  updateQueuedMessage(
    id: string,
    queuedId: string,
    request: UpdateQueuedMessageRequest,
  ): Promise<ChatQueuedMessage>;
  deleteQueuedMessage(id: string, queuedId: string): Promise<void>;
  /**
   * Moves a queued message into a running run as an inserted message.
   * Resolves with the stored item; 409 when the run is not `running` or the
   * insert limit is reached, 404 when the queued message no longer exists.
   */
  insertQueuedMessage(
    id: string,
    queuedId: string,
    request: InsertQueuedMessageRequest,
  ): Promise<ChatItem>;
  /** Puts the queue in the order of `ids`, which must be every id of the queue (409 otherwise). */
  reorderQueue(id: string, request: ReorderQueueRequest): Promise<ChatQueue>;
  /**
   * Sends the first queued message as a new run: the response is its stream.
   * `undefined` when the queue is empty or a run goes on.
   */
  resumeQueue(id: string, signal?: AbortSignal): Promise<Response | undefined>;
  /** What a message may carry, including whether the model reads images. */
  getInputConfig(): Promise<ChatInputConfig>;
  /**
   * Uploads one image to the session. `onProgress` is called with 0 at the
   * start and with the size when the upload has finished.
   */
  uploadAttachment(
    sessionId: string,
    body: Blob,
    name: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<ChatUploadedAttachment>;
  /** The bytes of one image of the session. */
  readAttachment(sessionId: string, attachmentId: string): Promise<Blob>;
}

/**
 * The API reference of the chat backend client.
 *
 * @public
 */
export const aiChatApiRef = createApiRef<AiChatApi>({
  id: 'plugin.ai-chat.service',
});

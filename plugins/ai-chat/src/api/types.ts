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
  ChatSession,
  ChatSessionDetail,
  ChatToolset,
  CreateChatSessionRequest,
  DecideToolCallRequest,
  ResumeChatRunRequest,
  SendChatMessageRequest,
  UpdateChatSessionRequest,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';

/**
 * The API of the chat backend. A method that answers with a stream of a run
 * returns the response as it is, so the caller reads the body while it
 * arrives; a failed request throws.
 *
 * @public
 */
export interface AiChatApi {
  listSessions(): Promise<ChatSession[]>;
  createSession(request?: CreateChatSessionRequest): Promise<ChatSession>;
  getSession(id: string): Promise<ChatSessionDetail>;
  updateSession(
    id: string,
    request: UpdateChatSessionRequest,
  ): Promise<ChatSession>;
  deleteSession(id: string): Promise<void>;
  listToolsets(): Promise<ChatToolset[]>;
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
}

/**
 * The API reference of the chat backend client.
 *
 * @public
 */
export const aiChatApiRef = createApiRef<AiChatApi>({
  id: 'plugin.ai-chat.service',
});

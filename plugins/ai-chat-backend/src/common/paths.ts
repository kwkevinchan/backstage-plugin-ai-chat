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

/**
 * Paths of the routes of the plugin, relative to `/api/ai-chat`.
 *
 * @public
 */
export const chatPaths = {
  conversations: () => '/conversations',
  conversation: (id: string) => `/conversations/${encodeURIComponent(id)}`,
  messages: (id: string) => `/conversations/${encodeURIComponent(id)}/messages`,
  approve: (id: string, callId: string) =>
    `/conversations/${encodeURIComponent(id)}/tool-calls/${encodeURIComponent(
      callId,
    )}/approve`,
  reject: (id: string, callId: string) =>
    `/conversations/${encodeURIComponent(id)}/tool-calls/${encodeURIComponent(
      callId,
    )}/reject`,
};

/**
 * The longest message a user can send, in characters.
 *
 * @public
 */
export const MAX_MESSAGE_LENGTH = 8000;

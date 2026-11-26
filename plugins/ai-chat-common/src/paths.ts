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
  sessions: () => '/sessions',
  session: (id: string) => `/sessions/${encodeURIComponent(id)}`,
  runs: (id: string) => `/sessions/${encodeURIComponent(id)}/runs`,
  cancelRun: (id: string, runId: string) =>
    `/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(
      runId,
    )}/cancel`,
  decision: (id: string, callId: string) =>
    `/sessions/${encodeURIComponent(id)}/tool-calls/${encodeURIComponent(
      callId,
    )}/decision`,
  attachments: (id: string) =>
    `/sessions/${encodeURIComponent(id)}/attachments`,
  attachment: (id: string, attachmentId: string) =>
    `/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(
      attachmentId,
    )}`,
  inputConfig: () => '/input-config',
  insertMessage: (id: string, runId: string) =>
    `/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(
      runId,
    )}/messages`,
  queue: (id: string) => `/sessions/${encodeURIComponent(id)}/queue`,
  queuedMessage: (id: string, queuedId: string) =>
    `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(queuedId)}`,
  insertQueuedMessage: (id: string, queuedId: string) =>
    `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(
      queuedId,
    )}/insert`,
  queueOrder: (id: string) => `/sessions/${encodeURIComponent(id)}/queue/order`,
  queueResume: (id: string) =>
    `/sessions/${encodeURIComponent(id)}/queue/resume`,
  resume: (id: string) => `/sessions/${encodeURIComponent(id)}/resume`,
  stream: (id: string) => `/sessions/${encodeURIComponent(id)}/stream`,
  shares: (id: string) => `/sessions/${encodeURIComponent(id)}/shares`,
  share: (id: string, shareId: string) =>
    `/sessions/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`,
  tools: (id: string) => `/sessions/${encodeURIComponent(id)}/tools`,
  toolsets: () => '/toolsets',
};

/**
 * The longest message a user can send, in characters.
 *
 * @public
 */
export const MAX_MESSAGE_LENGTH = 8000;

/**
 * The longest title of a session, in characters.
 *
 * @public
 */
export const MAX_TITLE_LENGTH = 200;

/**
 * The id of the assistant message that a run builds in the response stream.
 * Every stream of the run (the first one, the one after an approval, a
 * reconnect) starts with this id, so they all continue the same message. The
 * screen gives the same id to the assistant message it restores from the
 * stored items of the run.
 *
 * @public
 */
export function messageIdOfRun(runId: string): string {
  return `run_${runId}`;
}

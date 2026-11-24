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

import type {
  ChatItem,
  ChatItemBody,
  ChatRun,
  ChatSession,
  ChatSessionDetail,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from './api';

export const session: ChatSession = {
  id: 's-1',
  ownerRef: 'user:default/guest',
  agentId: 'default',
  enabledToolsets: ['read'],
  pinned: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

export function run(status: ChatRun['status'], id = 'r-1'): ChatRun {
  return {
    id,
    sessionId: session.id,
    status,
    cancelRequested: false,
    startedAt: '2026-01-01T10:00:00.000Z',
  };
}

/** Items with consecutive `seq` numbers, all of run `r-1` unless `runId` says otherwise. */
export function items(
  ...bodies: Array<ChatItemBody & { runId?: string }>
): ChatItem[] {
  return bodies.map((body, index) => ({
    runId: 'r-1',
    ...body,
    sessionId: session.id,
    seq: index + 1,
    createdAt: '2026-01-01T10:00:00.000Z',
  })) as ChatItem[];
}

export const user = (text: string): ChatItemBody & { runId: string } => ({
  kind: 'user_message',
  text,
  runId: 'r-1',
});

export const call = (
  callId: string,
  toolId = 'dev-actions:restart-service',
  input: Record<string, unknown> = { name: 'payments' },
  step = 1,
): ChatItemBody => ({
  kind: 'tool_call',
  callId,
  toolId,
  input: input as never,
  schemaHash: 'h',
  policy: 'ask',
  readOnly: false,
  step,
  position: 0,
});

export function detail(
  overrides: Partial<ChatSessionDetail> = {},
): ChatSessionDetail {
  return {
    session,
    items: [],
    awaitingDecision: [],
    resumable: false,
    ...overrides,
  };
}

export function mockApi(
  overrides: Partial<AiChatApi> = {},
): jest.Mocked<AiChatApi> {
  return {
    listSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn().mockResolvedValue(session),
    getSession: jest.fn().mockResolvedValue(detail()),
    updateSession: jest.fn().mockResolvedValue(session),
    deleteSession: jest.fn().mockResolvedValue(undefined),
    listToolsets: jest.fn().mockResolvedValue([]),
    listSessionTools: jest.fn().mockResolvedValue([]),
    sendMessage: jest.fn(),
    decide: jest.fn(),
    resume: jest.fn(),
    follow: jest.fn().mockResolvedValue(undefined),
    cancelRun: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<AiChatApi>;
}

/** A response of the stream of a run: `data:` lines for the chunks, and the end. */
export function streamResponse(chunks: object[]): Response {
  const lines = [...chunks.map(chunk => JSON.stringify(chunk)), '[DONE]'];
  const text = lines.map(line => `data: ${line}\n\n`).join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

import type { AiChatApi } from './api';
import type { ChatToolCall } from './common';

export const pendingCall: ChatToolCall = {
  id: 'call-1',
  messageId: 'm-2',
  actionId: 'dev-actions:restart-service',
  title: 'Restart a service',
  description: 'Restarts one of the example services.',
  input: { name: 'payments', force: true },
  attributes: { readOnly: false, destructive: true, idempotent: false },
  status: 'pending_approval',
  createdAt: '2026-01-01T10:00:00.000Z',
};

export const readCall: ChatToolCall = {
  id: 'call-0',
  messageId: 'm-2',
  actionId: 'dev-actions:list-services',
  title: 'List services',
  description: 'Lists the example services.',
  input: {},
  attributes: { readOnly: true, destructive: false, idempotent: true },
  status: 'succeeded',
  output: {
    services: [
      { name: 'payments', statusUrl: 'https://example.test/payments' },
    ],
  },
  createdAt: '2026-01-01T10:00:00.000Z',
};

export function mockApi(
  overrides: Partial<AiChatApi> = {},
): jest.Mocked<AiChatApi> {
  return {
    listConversations: jest.fn().mockResolvedValue([]),
    createConversation: jest.fn().mockResolvedValue({
      id: 'c-1',
      title: 'New conversation',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z',
    }),
    getConversation: jest.fn().mockRejectedValue(new Error('not found')),
    deleteConversation: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn(),
    approveToolCall: jest.fn(),
    rejectToolCall: jest.fn(),
    ...overrides,
  } as jest.Mocked<AiChatApi>;
}

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
  ChatInsertedData,
  ChatItemData,
  ChatNoticeData,
  ChatPlan,
  ChatQueueData,
  ChatRunData,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { JsonValue } from '@backstage/types';

/**
 * The chunks of the AI SDK UI message stream (`ai@7.0.166`) that the host
 * sends. The names and fields are those of `uiMessageChunkSchema` of the SDK;
 * the tests read every chunk back with it. The host does not import the SDK.
 */
export type UiMessageChunk =
  | { type: 'start'; messageId: string }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | {
      type: 'tool-input-available';
      toolCallId: string;
      toolName: string;
      input: JsonValue;
    }
  | {
      type: 'tool-approval-request';
      approvalId: string;
      toolCallId: string;
      reason?: string;
    }
  | {
      type: 'tool-approval-response';
      approvalId: string;
      approved: boolean;
    }
  | { type: 'tool-output-available'; toolCallId: string; output: JsonValue }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'tool-output-denied'; toolCallId: string }
  | { type: 'data-run'; data: ChatRunData; transient: true }
  | { type: 'data-item'; data: ChatItemData; transient: true }
  | { type: 'data-notice'; data: ChatNoticeData; transient: true }
  | { type: 'data-plan'; id: 'plan'; data: ChatPlan }
  | { type: 'data-inserted'; id: string; data: ChatInsertedData }
  | { type: 'data-queue'; data: ChatQueueData; transient: true }
  | {
      type: 'finish';
      finishReason: 'stop' | 'tool-calls';
    }
  | { type: 'error'; errorText: string }
  | { type: 'abort' };

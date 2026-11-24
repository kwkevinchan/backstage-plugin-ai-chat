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
  ChatConversationDetail,
  ChatEvent,
  ChatMessage,
  ChatToolCall,
} from '../common';

/** What the chat view shows for the open conversation. */
export interface ChatState {
  messages: ChatMessage[];
  toolCalls: ChatToolCall[];
  /** Text of the answer that is being written. */
  streamingText: string;
  /** A response stream is open. */
  streaming: boolean;
  notice?: string;
  error?: string;
}

export const emptyChatState: ChatState = {
  messages: [],
  toolCalls: [],
  streamingText: '',
  streaming: false,
};

export type ChatAction =
  | { type: 'loaded'; detail: ChatConversationDetail; error?: string }
  | { type: 'reset' }
  | { type: 'streamStarted' }
  | { type: 'streamEnded' }
  | { type: 'failed'; message: string }
  | { type: 'event'; event: ChatEvent };

function upsert(calls: ChatToolCall[], call: ChatToolCall): ChatToolCall[] {
  const index = calls.findIndex(c => c.id === call.id);
  if (index < 0) return [...calls, call];
  return calls.map((c, i) => (i === index ? call : c));
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'loaded':
      return {
        ...emptyChatState,
        messages: action.detail.messages,
        toolCalls: action.detail.toolCalls,
        error: action.error,
      };
    case 'reset':
      return emptyChatState;
    case 'streamStarted':
      return { ...state, streaming: true, error: undefined, notice: undefined };
    case 'streamEnded':
      return { ...state, streaming: false, streamingText: '' };
    case 'failed':
      return {
        ...state,
        streaming: false,
        streamingText: '',
        error: action.message,
      };
    case 'event': {
      const { event } = action;
      switch (event.type) {
        case 'user_message':
          return { ...state, messages: [...state.messages, event.message] };
        case 'text_delta':
          return { ...state, streamingText: state.streamingText + event.text };
        case 'assistant_message':
          return {
            ...state,
            streamingText: '',
            messages: [...state.messages, event.message],
          };
        case 'tool_call':
        case 'tool_result':
        case 'approval_required':
          return {
            ...state,
            toolCalls: upsert(state.toolCalls, event.toolCall),
          };
        case 'notice':
          return { ...state, notice: event.message };
        case 'error':
          return { ...state, error: event.message, streamingText: '' };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

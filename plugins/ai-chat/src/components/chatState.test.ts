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

import { pendingCall } from '../testData';
import { chatReducer, emptyChatState } from './chatState';

describe('chatReducer', () => {
  it('builds the streamed text and replaces it with the message', () => {
    let state = chatReducer(emptyChatState, { type: 'streamStarted' });
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'text_delta', text: 'a' },
    });
    state = chatReducer(state, {
      type: 'event',
      event: { type: 'text_delta', text: 'b' },
    });
    expect(state).toMatchObject({ streaming: true, streamingText: 'ab' });
    state = chatReducer(state, {
      type: 'event',
      event: {
        type: 'assistant_message',
        message: { id: 'm', role: 'assistant', content: 'ab', createdAt: '' },
      },
    });
    expect(state.streamingText).toBe('');
    expect(state.messages).toHaveLength(1);
  });

  it('keeps one entry for each tool call and takes the newest state', () => {
    let state = chatReducer(emptyChatState, {
      type: 'event',
      event: { type: 'approval_required', toolCall: pendingCall },
    });
    state = chatReducer(state, {
      type: 'event',
      event: {
        type: 'tool_result',
        toolCall: { ...pendingCall, status: 'succeeded' },
      },
    });
    expect(state.toolCalls).toEqual([{ ...pendingCall, status: 'succeeded' }]);
  });

  it('keeps the error and stops streaming', () => {
    const state = chatReducer(
      { ...emptyChatState, streaming: true, streamingText: 'x' },
      { type: 'failed', message: 'down' },
    );
    expect(state).toMatchObject({
      streaming: false,
      streamingText: '',
      error: 'down',
    });
  });

  it('clears the error when a new stream starts', () => {
    const state = chatReducer(
      { ...emptyChatState, error: 'old' },
      { type: 'streamStarted' },
    );
    expect(state.error).toBeUndefined();
  });
});

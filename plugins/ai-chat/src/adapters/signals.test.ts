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

import {
  AI_CHAT_SIGNAL_CHANNEL,
  parseSessionActivitySignal,
  signalApiRef,
} from './signals';

describe('signals adapter', () => {
  it('exposes the expected channel and Backstage signalApiRef id', () => {
    expect(AI_CHAT_SIGNAL_CHANNEL).toBe('ai-chat');
    expect(signalApiRef.id).toBe('plugin.signal.service');
  });

  it('parses valid session activity payloads and rejects malformed ones', () => {
    expect(
      parseSessionActivitySignal({ sessionId: 's-1', activity: 'running' }),
    ).toEqual({ sessionId: 's-1', activity: 'running' });
    expect(
      parseSessionActivitySignal({
        sessionId: 's-1',
        activity: 'waiting_approval',
      }),
    ).toEqual({ sessionId: 's-1', activity: 'waiting_approval' });
    expect(
      parseSessionActivitySignal({ sessionId: 's-1', activity: 'replied' }),
    ).toEqual({ sessionId: 's-1', activity: 'replied' });
    expect(
      parseSessionActivitySignal({ sessionId: 's-1', activity: 'idle' }),
    ).toEqual({ sessionId: 's-1', activity: 'idle' });

    expect(parseSessionActivitySignal(null)).toBeUndefined();
    expect(parseSessionActivitySignal({})).toBeUndefined();
    expect(
      parseSessionActivitySignal({ sessionId: '', activity: 'running' }),
    ).toBeUndefined();
    expect(
      parseSessionActivitySignal({ sessionId: 's-1', activity: 'unknown' }),
    ).toBeUndefined();
  });
});

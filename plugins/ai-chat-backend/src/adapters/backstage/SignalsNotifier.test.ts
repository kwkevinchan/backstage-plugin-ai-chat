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

import { NoopNotifier } from '../../application/ports';
import { AI_CHAT_SIGNAL_CHANNEL, SignalsNotifier } from './SignalsNotifier';

const input = {
  ownerRef: 'user:default/jane',
  sessionId: 's1',
  activity: 'running' as const,
};

describe('SignalsNotifier', () => {
  it('publishes the activity to the owner on the ai-chat channel', async () => {
    const publish = jest.fn(async () => {});
    const notifier = new SignalsNotifier({ publish });
    await notifier.notify(input);
    expect(publish).toHaveBeenCalledWith({
      recipients: { type: 'user', entityRef: 'user:default/jane' },
      channel: AI_CHAT_SIGNAL_CHANNEL,
      message: { sessionId: 's1', activity: 'running' },
    });
    expect(AI_CHAT_SIGNAL_CHANNEL).toBe('ai-chat');
  });

  it('swallows a failure of publish', async () => {
    const publish = jest.fn(async () => {
      throw new Error('signals down');
    });
    const notifier = new SignalsNotifier({ publish });
    await expect(
      notifier.notify({ ...input, activity: 'replied' }),
    ).resolves.toBeUndefined();
  });
});

describe('NoopNotifier', () => {
  it('resolves without a signals service', async () => {
    await expect(
      new NoopNotifier().notify({ ...input, activity: 'idle' }),
    ).resolves.toBeUndefined();
  });
});

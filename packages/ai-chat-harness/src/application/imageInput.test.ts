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

import type { ItemBody } from '../domain';
import { say } from '../testing';
import { kit, sessionId } from '../testing/fixture';

const withImage: ItemBody = {
  kind: 'user_message',
  text: 'what is this?',
  attachments: [
    { id: 'att-1', mediaType: 'image/png', name: 'shot.png', size: 10 },
  ],
};

describe('AdvanceRun: images (IN-05)', () => {
  it('gives the model the images of the message and tells it the session', async () => {
    const t = await kit({
      script: [[say('a screenshot')]],
      capabilities: { images: true },
      log: [withImage],
    });

    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(t.model.inputs[0].messages).toEqual([
      {
        role: 'user',
        content: 'what is this?',
        images: [
          { attachmentId: 'att-1', mediaType: 'image/png', name: 'shot.png' },
        ],
      },
    ]);
    expect(t.model.sessionIds).toEqual([sessionId]);
  });

  it('gives a model that cannot read images no image, only a line that says so', async () => {
    const t = await kit({
      script: [[say('no image seen')]],
      capabilities: { images: false },
      log: [withImage],
    });

    await t.execute();

    expect(t.model.inputs[0].messages).toEqual([
      {
        role: 'user',
        content:
          'what is this?\n[image: shot.png, not sent: the model cannot read images]',
      },
    ]);
  });
});

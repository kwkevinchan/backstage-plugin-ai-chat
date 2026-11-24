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

import type { SignalsService } from '@backstage/plugin-signals-node';
import type { Notifier, SessionActivity } from '../../application/ports';

/** The Signals channel the page listens on. */
export const AI_CHAT_SIGNAL_CHANNEL = 'ai-chat';

/**
 * Publishes the activity of a session to its owner (B-05). A failure of
 * `publish` is swallowed: the run must not fail because the notification did,
 * and the page polls when Signals is not there.
 */
export class SignalsNotifier implements Notifier {
  constructor(private readonly signals: Pick<SignalsService, 'publish'>) {}

  async notify(input: {
    ownerRef: string;
    sessionId: string;
    activity: SessionActivity;
  }): Promise<void> {
    try {
      await this.signals.publish({
        recipients: { type: 'user', entityRef: input.ownerRef },
        channel: AI_CHAT_SIGNAL_CHANNEL,
        message: {
          sessionId: input.sessionId,
          activity: input.activity,
        },
      });
    } catch {
      // The page still learns the state from the list.
    }
  }
}

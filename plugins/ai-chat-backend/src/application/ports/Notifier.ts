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
 * What the owner of a session is told when a run changes (B-05).
 *
 * - `running`: a run is under way.
 * - `waiting_approval`: a run waits for the user.
 * - `replied`: a run completed and has an answer.
 * - `idle`: a run failed, was cancelled, or expired. It is not one of the
 *   three names in the spec; without it a screen that only listens would
 *   stay on "processing".
 */
export type SessionActivity =
  | 'running'
  | 'waiting_approval'
  | 'replied'
  | 'idle';

/** Tells the owner that the activity of a session changed. */
export interface Notifier {
  notify(input: {
    ownerRef: string;
    sessionId: string;
    activity: SessionActivity;
  }): Promise<void>;
}

/** Does nothing. Used when Signals is not installed: the page polls instead. */
export class NoopNotifier implements Notifier {
  async notify(_input: Parameters<Notifier['notify']>[0]): Promise<void> {}
}

/**
 * Forwards to whatever notifier is installed. Starts as {@link NoopNotifier}.
 * A module may replace it at startup, before the plugin takes requests.
 */
export class DelegatingNotifier implements Notifier {
  private inner: Notifier = new NoopNotifier();

  use(notifier: Notifier): void {
    this.inner = notifier;
  }

  notify(input: Parameters<Notifier['notify']>[0]): Promise<void> {
    return this.inner.notify(input);
  }
}

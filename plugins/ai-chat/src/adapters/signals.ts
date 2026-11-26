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

import { createApiRef } from '@backstage/core-plugin-api';

/** The Signals channel published by the chat backend for session activity. */
export const AI_CHAT_SIGNAL_CHANNEL = 'ai-chat';

/** Activity states pushed over the Signals channel. */
export type SessionSignalActivity =
  | 'running'
  | 'waiting_approval'
  | 'replied'
  | 'idle';

/** One activity message sent on {@link AI_CHAT_SIGNAL_CHANNEL}. */
export type SessionActivitySignal = {
  sessionId: string;
  activity: SessionSignalActivity;
};

/**
 * Subset of Backstage's `SignalApi` (`@backstage/plugin-signals-react`) used
 * by the chat page. Looked up optionally through `useApiHolder()` so the
 * plugin works without installing the Signals frontend plugin; the page also
 * keeps low-frequency fallback polling even when Signals is present.
 */
export interface SignalApi {
  subscribe<TMessage = unknown>(
    channel: string,
    callback: (message: TMessage) => void,
  ): { unsubscribe: () => void };
}

/** Matches `signalApiRef` from `@backstage/plugin-signals-react` by API id. */
export const signalApiRef = createApiRef<SignalApi>({
  id: 'plugin.signal.service',
});

const ACTIVITIES = new Set<string>([
  'running',
  'waiting_approval',
  'replied',
  'idle',
]);

/** Validates an incoming Signals payload; returns `undefined` when malformed. */
export function parseSessionActivitySignal(
  message: unknown,
): SessionActivitySignal | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || !record.sessionId) {
    return undefined;
  }
  if (typeof record.activity !== 'string' || !ACTIVITIES.has(record.activity)) {
    return undefined;
  }
  return {
    sessionId: record.sessionId,
    activity: record.activity as SessionSignalActivity,
  };
}

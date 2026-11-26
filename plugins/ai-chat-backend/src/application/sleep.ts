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
 * Waits `ms`, or less when the signal aborts first. It never rejects: the
 * caller checks the signal after it.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const pending: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = () => {
      clearTimeout(pending.timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    pending.timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

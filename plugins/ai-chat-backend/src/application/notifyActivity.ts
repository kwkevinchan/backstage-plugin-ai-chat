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

import type { Logger, SessionActivity } from './ports';

export type ActivityNotifier = (
  sessionId: string,
  activity: SessionActivity,
) => Promise<void>;

/**
 * Tells the owner that the activity of a session changed. A failure is logged
 * and does not fail the caller.
 */
export function notifyActivity(
  notify: ActivityNotifier | undefined,
  logger: Logger | undefined,
  sessionId: string,
  activity: SessionActivity,
): void {
  if (!notify) return;
  void Promise.resolve()
    .then(() => notify(sessionId, activity))
    .catch(error => {
      logger?.warn('Could not notify the activity of a session', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

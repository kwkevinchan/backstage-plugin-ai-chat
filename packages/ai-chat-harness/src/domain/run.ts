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

import { InvalidRunTransition } from './errors';

/** @public */
export type RunStatus =
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * What a run has used so far. The host measures it; the working time does not
 * include the time spent waiting for an approval.
 *
 * @public
 */
export type RunUsage = {
  stepsUsed: number;
  toolCallsUsed: number;
  elapsedSeconds: number;
};

const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  running: ['waiting_approval', 'completed', 'failed', 'cancelled', 'expired'],
  // An approval resumes the same run.
  waiting_approval: ['running', 'failed', 'cancelled', 'expired'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

/** @public */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

/** Throws {@link InvalidRunTransition} when the change is not allowed. @public */
export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidRunTransition(from, to);
  }
}

/** A run that has not ended; a session has at most one (H-03). @public */
export function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'waiting_approval';
}

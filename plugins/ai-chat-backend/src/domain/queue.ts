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

import type {
  Limits,
  PageContext,
  RunOutcome,
} from '@kwkevinchan/ai-chat-harness';
import type { AttachmentMeta } from './attachment';
import type { Principal } from './principal';
import { CREDENTIALS_MARGIN_SECONDS } from './runLimits';

/** How many messages the user may insert into one run (IN-10). */
export const DEFAULT_INSERT_MAX_PER_RUN = 5;

/** How many messages a session may have in its queue (IN-13). */
export const DEFAULT_QUEUE_MAX_MESSAGES = 5;

/** A message that waits for the run of its session to end (IN-13). */
export type QueuedMessage = {
  id: string;
  sessionId: string;
  /** From 1, in the order the messages are sent. */
  position: number;
  text: string;
  attachments: AttachmentMeta[];
  page?: PageContext;
  createdAt: string;
  updatedAt: string;
};

/** Why the queue does not send by itself (IN-15, IN-16). */
export type PausedReason =
  | 'run_not_completed'
  | 'credentials'
  | 'shutting_down';

/**
 * Whether the run ended in the way that lets the queue go on: the model gave
 * its answer and no limit cut the run short (D-30). A failure, a stop, an
 * expiry or a limit pauses the queue, because sending the next message after
 * an error could make the error larger.
 */
export function isNormalEnd(outcome: RunOutcome): boolean {
  return outcome.status === 'completed' && outcome.endReason === undefined;
}

/**
 * Whether the credentials of the user last for a whole run (IN-16): the time
 * they have left must cover `runTimeoutSeconds` and the margin. Credentials
 * with no known expiry do not qualify: no user is there to see the tools fail.
 */
export function canAutoStart(
  principal: Pick<Principal, 'credentialsExpireAt'>,
  limits: Pick<Limits, 'runTimeoutSeconds'>,
  now: Date,
): boolean {
  if (principal.credentialsExpireAt === undefined) return false;
  const expires = Date.parse(principal.credentialsExpireAt);
  if (Number.isNaN(expires)) return false;
  const leftSeconds = (expires - now.getTime()) / 1000;
  return leftSeconds >= limits.runTimeoutSeconds + CREDENTIALS_MARGIN_SECONDS;
}

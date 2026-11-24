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

import type { Limits, RunUsage } from '@kwkevinchan/ai-chat-harness';
import type { Principal } from './principal';

/**
 * How long before the credentials expire a run stops working, in seconds. It
 * covers a tool call that began just before the end.
 */
export const CREDENTIALS_MARGIN_SECONDS = 30;

/**
 * The limits of a run, with the working time cut so that the run ends before
 * the credentials of the user expire (V-06). The tools run with those
 * credentials, so a run that goes on after they expire only gets errors.
 *
 * The time left is the configured time minus what the run used before
 * (waiting for an approval is not counted), or the time until the credentials
 * expire minus the margin, whichever is shorter. Credentials with no known
 * expiry leave the configured limit as it is.
 */
export function runLimits(
  base: Limits,
  usage: Pick<RunUsage, 'elapsedSeconds'>,
  principal: Pick<Principal, 'credentialsExpireAt'>,
  now: Date,
): Limits {
  if (principal.credentialsExpireAt === undefined) return base;
  const expires = Date.parse(principal.credentialsExpireAt);
  if (Number.isNaN(expires)) return base;
  const untilExpiry = Math.max(
    0,
    (expires - now.getTime()) / 1000 - CREDENTIALS_MARGIN_SECONDS,
  );
  const left = Math.max(0, base.runTimeoutSeconds - usage.elapsedSeconds);
  return {
    ...base,
    runTimeoutSeconds: usage.elapsedSeconds + Math.min(left, untilExpiry),
  };
}

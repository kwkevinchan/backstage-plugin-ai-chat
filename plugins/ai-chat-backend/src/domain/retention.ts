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

/** Days a session is kept when `aiChat.retention.days` is not set (SE-05). */
export const DEFAULT_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The instant a session's last change must be strictly before, for that
 * session to be past its retention (SE-05). `days` of 0 keeps every session.
 * One day is 24 hours. A change at the cutoff itself is kept.
 *
 * Throws when `days` is not an integer of at least 0. The configuration
 * check refuses that value before a backend starts; this is the same rule
 * for a caller that did not go through it.
 */
export function sessionRetentionCutoff(
  now: Date,
  days: number,
): Date | undefined {
  if (days === 0) return undefined;
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(
      `retention days must be an integer of at least 0, got ${days}`,
    );
  }
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Whether a session is past its retention. Only `updatedAt` counts: pinning
 * and archiving do not exempt a session, and they do not matter here. `days`
 * of 0 keeps it.
 */
export function isSessionExpired(
  updatedAt: string,
  now: Date,
  days: number,
): boolean {
  const cutoff = sessionRetentionCutoff(now, days);
  if (!cutoff) return false;
  const updated = Date.parse(updatedAt);
  return Number.isFinite(updated) && updated < cutoff.getTime();
}

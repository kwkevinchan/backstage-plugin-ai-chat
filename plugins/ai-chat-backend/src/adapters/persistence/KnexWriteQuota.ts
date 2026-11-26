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

import type { Knex } from 'knex';
import type { WriteQuota } from '../../application/ports';

const MINUTE_MS = 60_000;

/**
 * The changes per user and minute in the `write_quota_windows` table (T-10),
 * the same way as `KnexModelCallLimiter`: one row per user and minute, and
 * taking a change is one insert that adds one only while the row is below the
 * limit, so the database decides between backends. The rows of minutes before
 * the current one are deleted when this backend sees a new minute.
 *
 * The minutes are fixed: up to twice the limit can run around the turn of a
 * minute.
 */
export class KnexWriteQuota implements WriteQuota {
  /** The minute this backend last cleaned up. */
  private cleaned: string | undefined;

  constructor(private readonly knex: Knex) {}

  async tryTake(
    userRef: string,
    perMinute: number,
    now: Date,
  ): Promise<boolean> {
    const startMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
    const windowStart = new Date(startMs).toISOString();
    if (this.cleaned !== windowStart) {
      this.cleaned = windowStart;
      await this.knex('write_quota_windows')
        .where('window_start', '<', windowStart)
        .delete();
    }
    const rows = await this.knex('write_quota_windows')
      .insert({ user_ref: userRef, window_start: windowStart, writes: 1 })
      .onConflict(['user_ref', 'window_start'])
      .merge({
        writes: this.knex.raw('?? + 1', ['write_quota_windows.writes']),
      })
      .where('write_quota_windows.writes', '<', perMinute)
      .returning('writes');
    return rows.length > 0;
  }
}

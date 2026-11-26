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
import type { ModelCallLimiter } from '../../application/ports';

const MINUTE_MS = 60_000;

/**
 * The rate limit of model calls in the `model_call_windows` table (P-06): one
 * row per model and minute, with the calls taken in it. Taking a call is one
 * statement, an insert that adds one to the row of the minute only while it
 * is below the limit, so the database decides between backends. The rows of
 * minutes before the current one are deleted when a new minute is seen.
 *
 * The minutes are fixed: up to twice the limit can be sent around the turn of
 * a minute.
 */
export class KnexModelCallLimiter implements ModelCallLimiter {
  /** The minute this backend last cleaned up, per model. */
  private readonly cleaned = new Map<string, string>();

  constructor(private readonly knex: Knex) {}

  async tryAcquire(
    modelId: string,
    perMinute: number,
    now: Date,
  ): Promise<{ acquired: true } | { acquired: false; retryAt: Date }> {
    const startMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
    const windowStart = new Date(startMs).toISOString();
    if (this.cleaned.get(modelId) !== windowStart) {
      this.cleaned.set(modelId, windowStart);
      await this.knex('model_call_windows')
        .where({ model_id: modelId })
        .where('window_start', '<', windowStart)
        .delete();
    }
    const rows = await this.knex('model_call_windows')
      .insert({ model_id: modelId, window_start: windowStart, calls: 1 })
      .onConflict(['model_id', 'window_start'])
      .merge({ calls: this.knex.raw('?? + 1', ['model_call_windows.calls']) })
      .where('model_call_windows.calls', '<', perMinute)
      .returning('calls');
    if (rows.length > 0) return { acquired: true };
    return { acquired: false, retryAt: new Date(startMs + MINUTE_MS) };
  }
}

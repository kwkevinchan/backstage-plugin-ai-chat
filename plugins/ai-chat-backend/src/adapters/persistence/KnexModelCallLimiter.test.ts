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
import { createMigratedDb } from '../../__testUtils__';
import { KnexModelCallLimiter } from './KnexModelCallLimiter';

describe('KnexModelCallLimiter (P-06)', () => {
  let knex: Knex;

  beforeEach(async () => {
    knex = await createMigratedDb();
  });

  afterEach(async () => {
    await knex.destroy();
  });

  const at = (time: string) => new Date(`2026-01-01T${time}.000Z`);

  it('gives perMinute turns in a minute, then says when the next minute starts', async () => {
    const limiter = new KnexModelCallLimiter(knex);
    const turns = [];
    for (let i = 0; i < 3; i++) {
      turns.push(await limiter.tryAcquire('m', 2, at('00:00:10')));
    }
    expect(turns).toEqual([
      { acquired: true },
      { acquired: true },
      { acquired: false, retryAt: at('00:01:00') },
    ]);
    expect(await limiter.tryAcquire('other', 2, at('00:00:59'))).toEqual({
      acquired: true,
    });
    expect(await limiter.tryAcquire('m', 2, at('00:01:00'))).toEqual({
      acquired: true,
    });
  });

  it('shares the turns with another backend on the same database', async () => {
    const a = new KnexModelCallLimiter(knex);
    const b = new KnexModelCallLimiter(knex);
    expect(await a.tryAcquire('m', 1, at('00:00:00'))).toEqual({
      acquired: true,
    });
    expect(await b.tryAcquire('m', 1, at('00:00:30'))).toMatchObject({
      acquired: false,
    });
  });

  it('deletes the rows of the minutes before the current one', async () => {
    const limiter = new KnexModelCallLimiter(knex);
    await limiter.tryAcquire('m', 5, at('00:00:00'));
    await limiter.tryAcquire('m', 5, at('00:01:00'));
    await limiter.tryAcquire('m', 5, at('00:02:00'));
    const rows = await knex('model_call_windows').select(
      'model_id',
      'window_start',
      'calls',
    );
    expect(rows).toEqual([
      { model_id: 'm', window_start: '2026-01-01T00:02:00.000Z', calls: 1 },
    ]);
  });
});

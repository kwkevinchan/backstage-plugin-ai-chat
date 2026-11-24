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

import { EventChannel } from './EventChannel';

describe('EventChannel', () => {
  it('gives the events in order, also those pushed before the reader came', async () => {
    const channel = new EventChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.end();
    const seen: number[] = [];
    for await (const n of channel) seen.push(n);
    expect(seen).toEqual([1, 2]);
  });

  it('wakes a reader that waits', async () => {
    const channel = new EventChannel<number>();
    const read = (async () => {
      const seen: number[] = [];
      for await (const n of channel) seen.push(n);
      return seen;
    })();
    await Promise.resolve();
    channel.push(1);
    channel.end();
    expect(await read).toEqual([1]);
  });

  it('calls onClose once when the reader stops, and drops later events', async () => {
    const onClose = jest.fn();
    const channel = new EventChannel<number>(onClose);
    channel.push(1);
    for await (const n of channel) {
      expect(n).toBe(1);
      break;
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    channel.push(2);
    channel.end();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when the producer ended it', async () => {
    const onClose = jest.fn();
    const channel = new EventChannel<number>(onClose);
    channel.end();
    for await (const _ of channel) {
      // nothing
    }
    expect(onClose).not.toHaveBeenCalled();
  });
});

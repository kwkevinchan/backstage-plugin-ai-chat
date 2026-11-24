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

import { bodyChunks, parseEventStream } from './sse';

async function* pieces(...parts: string[]) {
  for (const part of parts) yield part;
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('parseEventStream', () => {
  it('reads events that are split anywhere', async () => {
    const text =
      'event: text_delta\ndata: {"type":"text_delta","text":"Hi"}\n\n' +
      'event: done\ndata: {"type":"done"}\n\n';
    for (const size of [1, 7, 1000]) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
      }
      expect(await collect(parseEventStream(pieces(...chunks)))).toEqual([
        { type: 'text_delta', text: 'Hi' },
        { type: 'done' },
      ]);
    }
  });

  it('accepts CRLF and an event without the final blank line', async () => {
    expect(
      await collect(
        parseEventStream(
          pieces(
            'data: {"type":"notice","message":"a"}\r\n\r\ndata: {"type":"done"}',
          ),
        ),
      ),
    ).toEqual([{ type: 'notice', message: 'a' }, { type: 'done' }]);
  });

  it('skips blocks that are no events', async () => {
    expect(
      await collect(
        parseEventStream(
          pieces(
            ': comment\n\ndata: not json\n\ndata: {"no":"type"}\n\ndata: {"type":"done"}\n\n',
          ),
        ),
      ),
    ).toEqual([{ type: 'done' }]);
  });
});

describe('bodyChunks', () => {
  it('decodes a character that is split between two chunks', async () => {
    const bytes = new TextEncoder().encode('é');
    const stream = {
      getReader() {
        const queue = [bytes.slice(0, 1), bytes.slice(1)];
        return {
          read: async () =>
            queue.length
              ? { done: false, value: queue.shift() }
              : { done: true, value: undefined },
          releaseLock: () => {},
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    expect((await collect(bodyChunks(stream))).join('')).toBe('é');
  });
});

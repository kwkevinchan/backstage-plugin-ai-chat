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

import type { ModelClient, ModelInput } from '@kwkevinchan/ai-chat-harness';
import { FakeClock } from '@kwkevinchan/ai-chat-harness/testing';
import { AttachmentNotFound } from '../domain';
import { HostModelClient, ModelCatalog } from './models';

const input: ModelInput = { system: 's', messages: [], tools: [] };

function inner() {
  const calls: unknown[] = [];
  const client: ModelClient = {
    capabilities: { parallelToolCalls: true, images: false },
    async *stream(_input, opts) {
      calls.push(opts);
      yield { type: 'text', text: 'answer' };
    },
  };
  return { client, calls };
}

async function collect(
  client: ModelClient,
  signal = new AbortController().signal,
) {
  const chunks: unknown[] = [];
  for await (const chunk of client.stream(input, { signal, sessionId: 's1' })) {
    chunks.push(chunk);
  }
  return chunks;
}

const noAttachments = {
  get: async () => {
    throw new AttachmentNotFound('a');
  },
};

describe('HostModelClient (X-09, P-06)', () => {
  it('keeps the capabilities of the client and gives it readImage', async () => {
    const { client, calls } = inner();
    const bytes = new Uint8Array([1, 2]);
    const host = new HostModelClient(client, {
      modelId: 'default',
      clock: new FakeClock(),
      attachments: {
        get: async (sessionId: string, id: string) => {
          if (id !== 'a1') throw new AttachmentNotFound(id);
          expect(sessionId).toBe('s1');
          return { bytes, meta: { mediaType: 'image/png' } } as never;
        },
      },
    });
    expect(host.capabilities).toEqual(client.capabilities);
    expect(await collect(host)).toEqual([{ type: 'text', text: 'answer' }]);
    const opts = calls[0] as { readImage: Function; sessionId: string };
    expect(opts.sessionId).toBe('s1');
    const image = { mediaType: 'image/png', name: 'a.png' };
    expect(await opts.readImage({ ...image, attachmentId: 'a1' })).toEqual({
      mediaType: 'image/png',
      bytes,
    });
    expect(
      await opts.readImage({ ...image, attachmentId: 'b' }),
    ).toBeUndefined();
  });

  it('waits until the next minute when the limiter gives no turn, then asks again', async () => {
    const { client, calls } = inner();
    const clock = new FakeClock(new Date('2026-01-01T00:00:45.000Z'));
    const limiter = {
      tryAcquire: jest
        .fn()
        .mockResolvedValueOnce({
          acquired: false,
          retryAt: new Date('2026-01-01T00:01:00.000Z'),
        })
        .mockResolvedValueOnce({ acquired: true }),
    };
    const waits: number[] = [];
    const host = new HostModelClient(client, {
      modelId: 'small',
      clock,
      attachments: noAttachments,
      rate: { limiter, perMinute: 2 },
      sleep: async ms => {
        waits.push(ms);
        clock.advance(15);
      },
    });

    await collect(host);

    expect(limiter.tryAcquire).toHaveBeenCalledTimes(2);
    expect(limiter.tryAcquire).toHaveBeenCalledWith(
      'small',
      2,
      expect.any(Date),
    );
    // 15 seconds to the next minute, and less than a quarter of a second more.
    expect(waits[0]).toBeGreaterThanOrEqual(15_000);
    expect(waits[0]).toBeLessThan(15_250);
    expect(calls).toHaveLength(1);
  });

  it('throws, and does not call the model, when the signal aborts while it waits', async () => {
    const { client, calls } = inner();
    const controller = new AbortController();
    const host = new HostModelClient(client, {
      modelId: 'default',
      clock: new FakeClock(),
      attachments: noAttachments,
      rate: {
        limiter: {
          tryAcquire: async () => ({
            acquired: false,
            retryAt: new Date('2026-01-01T00:01:00.000Z'),
          }),
        },
        perMinute: 1,
      },
    });
    const done = collect(host, controller.signal);
    controller.abort();
    await expect(done).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe('ModelCatalog', () => {
  it('gives the client of the model of the agent, and default for an agent without one', () => {
    const a = inner().client;
    const b = inner().client;
    const catalog = new ModelCatalog(
      new Map([
        ['default', a],
        ['small', b],
      ]),
    );
    expect(catalog.forAgent({})).toBe(a);
    expect(catalog.forAgent({ model: 'small' })).toBe(b);
    expect(() => catalog.forAgent({ model: 'gone' })).toThrow(
      'There is no model gone',
    );
  });
});

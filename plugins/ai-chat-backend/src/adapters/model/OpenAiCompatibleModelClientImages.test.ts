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

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mockServices } from '@backstage/backend-test-utils';
import {
  buildModelInput,
  type Item,
  type ModelChunk,
  type ModelInput,
} from '@kwkevinchan/ai-chat-harness';
import { IMAGES } from '../../__testUtils__/images';
import type { AttachmentStore } from '../../application/ports';
import { AttachmentNotFound, type AttachmentMeta } from '../../domain';
import {
  OpenAiCompatibleClient,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
} from './OpenAiCompatibleClient';
import { OpenAiCompatibleModelClient } from './OpenAiCompatibleModelClient';

const signal = new AbortController().signal;
const opts = { signal, sessionId: 'session-1' };

/** A store with the images of the test, by session and id. */
class MemoryStore implements AttachmentStore {
  readonly reads: [string, string][] = [];
  constructor(
    private readonly files: Record<
      string,
      { type: AttachmentMeta['mediaType']; bytes: Buffer }
    >,
  ) {}

  async get(sessionId: string, id: string) {
    this.reads.push([sessionId, id]);
    const file = sessionId === 'session-1' ? this.files[id] : undefined;
    if (!file) throw new AttachmentNotFound(id);
    return {
      meta: {
        id,
        sessionId,
        mediaType: file.type,
        name: id,
        size: file.bytes.length,
        sha256: '',
      },
      bytes: new Uint8Array(file.bytes),
    };
  }

  put = jest.fn();
  describe = jest.fn();
  copy = jest.fn();
  purgeUnused = jest.fn();
}

const dataUrlOf = (type: string, bytes: Buffer) =>
  `data:${type};base64,${bytes.toString('base64')}`;

function setup(images: boolean, store: MemoryStore) {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    async complete(request) {
      requests.push(request);
      return { content: 'ok', toolCalls: [] };
    },
  };
  const logger = mockServices.logger.mock();
  const client = new OpenAiCompatibleModelClient(llm, {
    attachments: store,
    images,
    logger,
  });
  return { client, requests, logger };
}

async function collect(stream: AsyncIterable<ModelChunk>) {
  const out: ModelChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const withImages = (...ids: string[]): ModelInput => ({
  system: 'sys',
  tools: [],
  messages: [
    {
      role: 'user',
      content: 'what is this?',
      images: ids.map(id => ({
        attachmentId: id,
        mediaType: 'image/png',
        name: `${id}.png`,
      })),
    },
  ],
});

describe('OpenAiCompatibleModelClient: images (IN-05, IN-07)', () => {
  it('says what the model can do', () => {
    const store = new MemoryStore({});
    expect(setup(true, store).client.capabilities).toEqual({
      parallelToolCalls: false,
      images: true,
    });
    expect(setup(false, store).client.capabilities.images).toBe(false);
  });

  it('sends a message with images as a content array: the text first, then an image_url with a data URL of the bytes', async () => {
    const store = new MemoryStore({
      a: { type: 'image/png', bytes: IMAGES['image/png'] },
      b: { type: 'image/jpeg', bytes: IMAGES['image/jpeg'] },
    });
    const { client, requests } = setup(true, store);

    await collect(client.stream(withImages('a', 'b'), opts));

    const user = requests[0].messages[1];
    expect(user).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image_url',
          image_url: { url: dataUrlOf('image/png', IMAGES['image/png']) },
        },
        {
          type: 'image_url',
          image_url: { url: dataUrlOf('image/jpeg', IMAGES['image/jpeg']) },
        },
      ],
    });
    // The bytes of the data URL are the bytes that were stored.
    const url = (user as Extract<LlmMessage, { role: 'user' }>).content as {
      type: string;
      image_url?: { url: string };
    }[];
    const decoded = Buffer.from(url[1].image_url!.url.split(',')[1], 'base64');
    expect(decoded.equals(IMAGES['image/png'])).toBe(true);
  });

  it('sends a message that has images and no text as image parts only', async () => {
    const store = new MemoryStore({
      a: { type: 'image/png', bytes: IMAGES['image/png'] },
    });
    const { client, requests } = setup(true, store);
    const input: ModelInput = {
      system: 'sys',
      tools: [],
      messages: [
        {
          role: 'user',
          content: '',
          images: [
            { attachmentId: 'a', mediaType: 'image/png', name: 'a.png' },
          ],
        },
      ],
    };

    await collect(client.stream(input, opts));

    expect(requests[0].messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: dataUrlOf('image/png', IMAGES['image/png']) },
        },
      ],
    });
  });

  it('reads the images from the session of the call and no other', async () => {
    const store = new MemoryStore({
      a: { type: 'image/png', bytes: IMAGES['image/png'] },
    });
    const { client, requests } = setup(true, store);

    await collect(
      client.stream(withImages('a'), { signal, sessionId: 'session-2' }),
    );

    expect(store.reads).toEqual([['session-2', 'a']]);
    // The image of another session is not read: it is "not available".
    expect(JSON.stringify(requests[0].messages)).not.toContain('image_url');
  });

  it('keeps a string as the content of a message without images, and of any other role', async () => {
    const store = new MemoryStore({});
    const { client, requests } = setup(true, store);
    await collect(
      client.stream(
        {
          system: 'sys',
          tools: [],
          messages: [
            { role: 'user', content: 'plain' },
            { role: 'assistant', content: 'hi', toolCalls: [] },
          ],
        },
        opts,
      ),
    );
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(store.reads).toEqual([]);
  });

  it('puts "not available" in the text for an image that cannot be read, and the call goes on', async () => {
    const store = new MemoryStore({
      a: { type: 'image/png', bytes: IMAGES['image/png'] },
    });
    const { client, requests, logger } = setup(true, store);

    await collect(client.stream(withImages('gone', 'a'), opts));

    // The call was made.
    expect(requests).toHaveLength(1);
    const parts = (requests[0].messages[1] as any).content;
    expect(parts[0]).toEqual({
      type: 'text',
      text: 'what is this?\n[image: gone.png, not available]',
    });
    expect(parts).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('sends a string when no image can be read', async () => {
    const store = new MemoryStore({});
    const { client, requests } = setup(true, store);
    await collect(client.stream(withImages('gone'), opts));
    expect(requests[0].messages[1]).toEqual({
      role: 'user',
      content: 'what is this?\n[image: gone.png, not available]',
    });
  });

  it('fails the call when the store itself fails, which is not a missing image', async () => {
    const store = new MemoryStore({});
    store.get = async () => {
      throw new Error('database down');
    };
    const { client } = setup(true, store);
    await expect(collect(client.stream(withImages('a'), opts))).rejects.toThrow(
      'database down',
    );
  });

  describe('with the input of the core', () => {
    const items = [
      {
        kind: 'user_message',
        text: 'what is this?',
        attachments: [
          { id: 'a', mediaType: 'image/png', name: 'shot.png', size: 70 },
        ],
        sessionId: 'session-1',
        seq: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ] as Item[];
    const input = (images: boolean) =>
      buildModelInput(
        items,
        { id: 'default', systemPrompt: 'sys' },
        { context: [], tools: [], images },
        { tokenBudget: 24000, keepRecentSteps: 6 },
      );

    it('has no image_url, and says the image was not sent, when the model cannot read images', async () => {
      const store = new MemoryStore({
        a: { type: 'image/png', bytes: IMAGES['image/png'] },
      });
      const { client, requests } = setup(false, store);

      await collect(client.stream(input(false), opts));

      expect(JSON.stringify(requests[0])).not.toContain('image_url');
      expect(requests[0].messages[1]).toEqual({
        role: 'user',
        content:
          'what is this?\n[image: shot.png, not sent: the model cannot read images]',
      });
      expect(store.reads).toEqual([]);
    });

    it('sends the image when it can', async () => {
      const store = new MemoryStore({
        a: { type: 'image/png', bytes: IMAGES['image/png'] },
      });
      const { client, requests } = setup(true, store);
      await collect(client.stream(input(true), opts));
      expect(JSON.stringify(requests[0])).toContain('image_url');
    });
  });
});

/**
 * The request on the wire: what a server of the OpenAI Chat Completions API
 * gets (V-08). `scripts/fake-llm.mjs` reads the same shape.
 */
describe('the request to the model server, with images (V-08)', () => {
  let server: Server;
  let body: any;

  beforeEach(async () => {
    server = createServer((req, res) => {
      let text = '';
      req.on('data', d => (text += d));
      req.on('end', () => {
        body = JSON.parse(text);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'seen' } }],
          }),
        );
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
  });

  afterEach(() => {
    server.close();
  });

  it('is JSON with the text part first and the image_url parts after, and the bytes decode to the stored ones', async () => {
    const { port } = server.address() as AddressInfo;
    const store = new MemoryStore({
      a: { type: 'image/webp', bytes: IMAGES['image/webp'] },
    });
    const client = new OpenAiCompatibleModelClient(
      new OpenAiCompatibleClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'm',
        timeoutMs: 5000,
      }),
      { attachments: store, images: true, logger: mockServices.logger.mock() },
    );

    const chunks = await collect(client.stream(withImages('a'), opts));

    expect(chunks).toEqual([{ type: 'text', text: 'seen' }]);
    const content = body.messages[1].content;
    expect(content[0]).toEqual({ type: 'text', text: 'what is this?' });
    expect(content[1].type).toBe('image_url');
    const [head, data] = content[1].image_url.url.split(',');
    expect(head).toBe('data:image/webp;base64');
    expect(Buffer.from(data, 'base64').equals(IMAGES['image/webp'])).toBe(true);
  });
});

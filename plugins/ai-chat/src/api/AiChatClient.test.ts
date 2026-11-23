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

import { AiChatClient } from './AiChatClient';

function streamBody(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    getReader() {
      let done = false;
      return {
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: bytes };
        },
        releaseLock: () => {},
      };
    },
  };
}

function setup(response: Partial<Response> & { jsonBody?: unknown }) {
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response.jsonBody,
    ...response,
  });
  const client = new AiChatClient({
    discoveryApi: { getBaseUrl: async () => 'http://backend/api/ai-chat' },
    fetchApi: { fetch },
  });
  return { client, fetch };
}

describe('AiChatClient', () => {
  it('reads the list and one conversation', async () => {
    const list = setup({ jsonBody: { items: [{ id: 'a' }] } });
    expect(await list.client.listConversations()).toEqual([{ id: 'a' }]);
    expect(list.fetch).toHaveBeenCalledWith(
      'http://backend/api/ai-chat/conversations',
      undefined,
    );
    const one = setup({ jsonBody: { conversation: { id: 'a/b' } } });
    await one.client.getConversation('a/b');
    expect(one.fetch.mock.calls[0][0]).toBe(
      'http://backend/api/ai-chat/conversations/a%2Fb',
    );
  });

  it('creates and deletes with the right methods', async () => {
    const { client, fetch } = setup({ jsonBody: { id: 'new' } });
    expect(await client.createConversation()).toEqual({ id: 'new' });
    await client.deleteConversation('x');
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['http://backend/api/ai-chat/conversations', 'POST'],
      ['http://backend/api/ai-chat/conversations/x', 'DELETE'],
    ]);
  });

  it('sends a message and reads the events of the stream', async () => {
    const { client, fetch } = setup({
      body: streamBody(
        'event: user_message\ndata: {"type":"text_delta","text":"A"}\n\ndata: {"type":"done"}\n\n',
      ) as any,
    });
    const signal = new AbortController().signal;
    const events = [];
    for await (const event of client.sendMessage('c1', 'hello', signal)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text_delta', text: 'A' },
      { type: 'done' },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://backend/api/ai-chat/conversations/c1/messages');
    expect(init).toMatchObject({ method: 'POST', signal });
    expect(JSON.parse(init.body)).toEqual({ content: 'hello' });
  });

  it('posts to the approve and reject routes of the call', async () => {
    const { client, fetch } = setup({
      body: streamBody('data: {"type":"done"}\n\n') as any,
    });
    for await (const _ of client.approveToolCall('c1', 'k1')) {
      // drain
    }
    for await (const _ of client.rejectToolCall('c1', 'k1')) {
      // drain
    }
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [
        'http://backend/api/ai-chat/conversations/c1/tool-calls/k1/approve',
        'POST',
      ],
      [
        'http://backend/api/ai-chat/conversations/c1/tool-calls/k1/reject',
        'POST',
      ],
    ]);
  });

  it('turns an error status into an error with the message of the backend', async () => {
    const { client } = setup({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({
          error: { name: 'ConflictError', message: 'not waiting' },
          response: { statusCode: 409 },
        }),
    } as any);
    await expect(
      (async () => {
        for await (const _ of client.approveToolCall('c1', 'k1')) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      message: 'Request failed with 409 Conflict',
      cause: { message: 'not waiting' },
    });
  });
});

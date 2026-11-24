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

import { ResponseError } from '@backstage/errors';
import { AiChatClient } from './AiChatClient';

function setup(response: Response | (() => Response)) {
  const fetch = jest
    .fn()
    .mockImplementation(async () =>
      typeof response === 'function' ? response() : response,
    );
  const client = new AiChatClient({
    discoveryApi: { getBaseUrl: async () => 'http://backend/api/ai-chat' },
    fetchApi: { fetch },
  });
  return { client, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const urls = (fetch: jest.Mock) =>
  fetch.mock.calls.map(([url, init]) => [init?.method ?? 'GET', url]);

describe('AiChatClient', () => {
  it('reads the list, one session and the toolsets', async () => {
    const list = setup(json({ items: [{ id: 'a' }] }));
    expect(await list.client.listSessions()).toEqual([{ id: 'a' }]);
    const one = setup(json({ session: { id: 'a/b' } }));
    await one.client.getSession('a/b');
    const sets = setup(json({ items: [{ id: 'read' }] }));
    expect(await sets.client.listToolsets()).toEqual([{ id: 'read' }]);
    expect(urls(list.fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/sessions'],
    ]);
    expect(urls(one.fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/sessions/a%2Fb'],
    ]);
    expect(urls(sets.fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/toolsets'],
    ]);
  });

  it('creates, updates and deletes with the right methods and bodies', async () => {
    const { client, fetch } = setup(() => json({ id: 'new' }));
    await client.createSession({ enabledToolsets: ['read'] });
    await client.updateSession('x', { enabledToolsets: [] });
    await client.deleteSession('x');
    expect(urls(fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions'],
      ['PATCH', 'http://backend/api/ai-chat/sessions/x'],
      ['DELETE', 'http://backend/api/ai-chat/sessions/x'],
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      enabledToolsets: ['read'],
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      enabledToolsets: [],
    });
  });

  it('posts a message, a decision and a resume, and gives the response as it is', async () => {
    const { client, fetch } = setup(() => new Response('data: [DONE]\n\n'));
    const signal = new AbortController().signal;
    const page = { path: '/ai-chat' };
    await client.sendMessage('s', { text: 'hi', page }, signal);
    await client.decide('s', 'c/1', { approved: true, page }, signal);
    await client.resume('s', { page }, signal);
    expect(urls(fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions/s/runs'],
      [
        'POST',
        'http://backend/api/ai-chat/sessions/s/tool-calls/c%2F1/decision',
      ],
      ['POST', 'http://backend/api/ai-chat/sessions/s/resume'],
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      text: 'hi',
      page,
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      approved: true,
      page,
    });
    expect(fetch.mock.calls[0][1].signal).toBe(signal);
  });

  it('gives undefined for 204 of resume and of the stream, and never sends afterSeq', async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }));
    expect(await client.resume('s', {})).toBeUndefined();
    expect(await client.follow('s')).toBeUndefined();
    expect(fetch.mock.calls[1][0]).toBe(
      'http://backend/api/ai-chat/sessions/s/stream',
    );
  });

  it('throws the error of the backend for a failed request', async () => {
    const { client } = setup(
      json(
        { error: { name: 'ConflictError', message: 'A run is active' } },
        409,
      ),
    );
    await expect(client.sendMessage('s', { text: 'x' })).rejects.toBeInstanceOf(
      ResponseError,
    );
  });

  it('cancels a run, and does not fail when the run has ended (409)', async () => {
    const ok = setup(() => json({}, 202));
    await ok.client.cancelRun('s', 'r/1');
    expect(urls(ok.fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions/s/runs/r%2F1/cancel'],
    ]);
    const ended = setup(() =>
      json({ error: { name: 'ConflictError', message: 'ended' } }, 409),
    );
    await expect(ended.client.cancelRun('s', 'r')).resolves.toBeUndefined();
    const broken = setup(() =>
      json({ error: { name: 'Error', message: 'down' } }, 503),
    );
    await expect(broken.client.cancelRun('s', 'r')).rejects.toBeInstanceOf(
      ResponseError,
    );
  });
});

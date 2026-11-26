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

  it('lists, makes, changes and cancels the shares of a session (P2-04)', async () => {
    const share = { id: 'sh/1', subjectRef: 'user:default/bob' };
    const { client, fetch } = setup(() => json({ items: [share], ...share }));
    expect(await client.listShares('a/b')).toEqual([share]);
    expect(
      await client.createShare('a/b', {
        subjectRef: 'user:default/bob',
        mode: 'live',
      }),
    ).toMatchObject(share);
    await client.updateShare('a/b', 'sh/1', { includeToolOutputs: false });
    await client.revokeShare('a/b', 'sh/1');
    expect(urls(fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/sessions/a%2Fb/shares'],
      ['POST', 'http://backend/api/ai-chat/sessions/a%2Fb/shares'],
      ['PATCH', 'http://backend/api/ai-chat/sessions/a%2Fb/shares/sh%2F1'],
      ['DELETE', 'http://backend/api/ai-chat/sessions/a%2Fb/shares/sh%2F1'],
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      subjectRef: 'user:default/bob',
      mode: 'live',
    });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
      includeToolOutputs: false,
    });
  });

  it('throws the answer of a refused share', async () => {
    const { client } = setup(
      json({ error: { name: 'ShareNotFound', message: 'x' } }, 404),
    );
    await expect(client.revokeShare('a', 'sh1')).rejects.toBeInstanceOf(
      ResponseError,
    );
  });

  it('sends a title search and the archived flag as query parameters', async () => {
    const { client, fetch } = setup(json({ items: [] }));
    await client.listSessions({ query: 'Build', includeArchived: true });
    expect(urls(fetch)).toEqual([
      [
        'GET',
        'http://backend/api/ai-chat/sessions?q=Build&includeArchived=true',
      ],
    ]);
  });

  it('sends the entity of the sessions to list, encoded (SE-06)', async () => {
    const { client, fetch } = setup(json({ items: [] }));
    await client.listSessions({ entityRef: 'component:default/a b&c' });
    expect(urls(fetch)).toEqual([
      [
        'GET',
        'http://backend/api/ai-chat/sessions?entityRef=component%3Adefault%2Fa+b%26c',
      ],
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

  it('inserts a message into a run and returns the stored item', async () => {
    const { client, fetch } = setup(() =>
      json({ kind: 'user_message', seq: 4, text: 'also this' }, 201),
    );
    const item = await client.insertMessage('s', 'r/1', {
      text: 'also this',
      page: { path: '/x' },
    });
    expect(item).toMatchObject({ seq: 4, text: 'also this' });
    expect(urls(fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions/s/runs/r%2F1/messages'],
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      text: 'also this',
      page: { path: '/x' },
    });
  });

  it('keeps the name of a 409 so that the screen can tell the refusals apart', async () => {
    const { client } = setup(() =>
      json(
        {
          error: { name: 'InsertLimitReached', message: 'too many' },
          request: { method: 'POST', url: '/x' },
          response: { statusCode: 409 },
        },
        409,
      ),
    );
    const error = await client
      .insertMessage('s', 'r', { text: 'x' })
      .catch(e => e);
    expect(error).toBeInstanceOf(ResponseError);
    expect(error.response.status).toBe(409);
    expect(error.body.error.name).toBe('InsertLimitReached');
  });

  it('reads and changes the queue with the routes of the queue', async () => {
    const queue = {
      items: [{ id: 'q1', position: 1, text: 'a' }],
      paused: false,
    };
    const read = setup(json(queue));
    expect(await read.client.getQueue('s')).toEqual(queue);

    const add = setup(json(queue.items[0], 201));
    expect(await add.client.queueMessage('s', { text: 'a' })).toEqual(
      queue.items[0],
    );

    const edit = setup(json(queue.items[0]));
    await edit.client.updateQueuedMessage('s', 'q/1', { text: 'b' });

    const del = setup(() => new Response(null, { status: 204 }));
    await del.client.deleteQueuedMessage('s', 'q1');

    const order = setup(json(queue));
    expect(await order.client.reorderQueue('s', { ids: ['q2', 'q1'] })).toEqual(
      queue,
    );

    expect(urls(read.fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/sessions/s/queue'],
    ]);
    expect(urls(add.fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions/s/queue'],
    ]);
    expect(urls(edit.fetch)).toEqual([
      ['PATCH', 'http://backend/api/ai-chat/sessions/s/queue/q%2F1'],
    ]);
    expect(urls(del.fetch)).toEqual([
      ['DELETE', 'http://backend/api/ai-chat/sessions/s/queue/q1'],
    ]);
    expect(urls(order.fetch)).toEqual([
      ['PUT', 'http://backend/api/ai-chat/sessions/s/queue/order'],
    ]);
    expect(JSON.parse(order.fetch.mock.calls[0][1].body)).toEqual({
      ids: ['q2', 'q1'],
    });
  });

  it('turns a queued message into an insert with POST /queue/:queuedId/insert', async () => {
    const item = {
      kind: 'user_message',
      seq: 3,
      runId: 'r1',
      text: 'send now',
      delivery: 'inserted',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { client, fetch } = setup(json(item, 201));
    expect(
      await client.insertQueuedMessage('s', 'q/1', { runId: 'r1' }),
    ).toEqual(item);
    expect(urls(fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions/s/queue/q%2F1/insert'],
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ runId: 'r1' });
  });

  it('continues the queue: the stream of the new run, or nothing (204)', async () => {
    const stream = setup(
      () =>
        new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    expect(await stream.client.resumeQueue('s')).toBeInstanceOf(Response);
    expect(urls(stream.fetch)).toEqual([
      ['POST', 'http://backend/api/ai-chat/sessions/s/queue/resume'],
    ]);
    const nothing = setup(() => new Response(null, { status: 204 }));
    expect(await nothing.client.resumeQueue('s')).toBeUndefined();
  });

  it('reads the input config, uploads an image and reads its bytes', async () => {
    const config = setup(
      json({
        images: { enabled: true },
        insertMaxPerRun: 5,
        queueMaxMessages: 5,
      }),
    );
    expect(await config.client.getInputConfig()).toMatchObject({
      images: { enabled: true },
    });
    expect(urls(config.fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/input-config'],
    ]);

    const progress: number[] = [];
    const upload = setup(json({ id: 'att-1', name: 'dot.png' }));
    const body = new Blob([new Uint8Array(4)], { type: 'image/png' });
    await upload.client.uploadAttachment('s/1', body, 'dot.png', loaded =>
      progress.push(loaded),
    );
    expect(urls(upload.fetch)).toEqual([
      [
        'POST',
        'http://backend/api/ai-chat/sessions/s%2F1/attachments?name=dot.png',
      ],
    ]);
    expect(upload.fetch.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'image/png',
    });
    expect(upload.fetch.mock.calls[0][1].body).toBe(body);
    expect(progress).toEqual([0, 4]);

    const bytes = new Blob([new Uint8Array(4)], { type: 'image/png' });
    const read = setup(new Response(bytes));
    expect(await read.client.readAttachment('s/1', 'att/1')).toBeInstanceOf(
      Blob,
    );
    expect(urls(read.fetch)).toEqual([
      ['GET', 'http://backend/api/ai-chat/sessions/s%2F1/attachments/att%2F1'],
    ]);
  });
});

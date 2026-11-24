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

import { createServiceFactory } from '@backstage/backend-plugin-api';
import { actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import knex from 'knex';
import request from 'supertest';
import { TITLE_PROMPT_MARK } from './application';
import {
  parseSse,
  readMessage,
} from './adapters/http/__testUtils__/uiMessageStream';
import {
  createDb,
  FakeActions,
  LlmServer,
  sseBody,
  startLlmServer,
} from './__testUtils__';
import { aiChatPlugin } from './plugin';

const chunk = (delta: unknown) => ({ choices: [{ index: 0, delta }] });
const text = (content: string) => sseBody([chunk({ content }), chunk({})]);
const call = (name: string, args: unknown) =>
  sseBody([
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
  ]);

describe('aiChatPlugin', () => {
  let llm: LlmServer;
  let answers: string[];
  let actions: FakeActions;
  let auditEvents: string[];

  afterEach(async () => {
    await llm?.close();
  });

  async function startBackend(respond?: Parameters<typeof startLlmServer>[0]) {
    answers = [];
    // A title call is not one of the scripted answers. It gets a fixed title
    // so the next step of the conversation still gets the answer it expects.
    let scripted = 0;
    llm = await startLlmServer(
      respond ??
        (body => {
          const system = body.messages?.find(
            (message: { role?: string }) => message.role === 'system',
          );
          const content = system?.content;
          if (
            typeof content === 'string' &&
            content.startsWith(TITLE_PROMPT_MARK)
          ) {
            return { body: text('Generated title') };
          }
          const index = scripted;
          scripted += 1;
          return {
            body: answers[Math.min(index, answers.length - 1)],
          };
        }),
    );
    actions = new FakeActions([
      { id: 'demo:list-things', readOnly: true, run: () => ({ things: [1] }) },
      { id: 'demo:change-thing', destructive: true },
    ]);
    auditEvents = [];
    const auditor = mockServices.auditor.mock({
      createEvent: async options => {
        auditEvents.push(options.eventId);
        return { success: async () => {}, fail: async () => {} };
      },
    });
    const { server } = await startTestBackend({
      features: [
        aiChatPlugin,
        mockServices.rootConfig.factory({
          data: {
            aiChat: { llm: { baseUrl: llm.url, model: 'test-model' } },
          },
        }),
        // The plugin runs its own migrations.
        mockServices.database.factory({ knex: await createDb() }),
        auditor.factory,
        // A request without credentials is a request of nobody.
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        createServiceFactory({
          service: actionsServiceRef,
          deps: {},
          factory: () => actions,
        }),
      ],
    });
    return server;
  }

  const alice = mockCredentials.user.header('user:default/alice');
  const bob = mockCredentials.user.header('user:default/bob');

  it('does not start when the SQLite pool allows more than one connection', async () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 2 },
      useNullAsDefault: true,
    });
    try {
      await expect(
        startTestBackend({
          features: [
            aiChatPlugin,
            mockServices.rootConfig.factory({
              data: {
                aiChat: {
                  llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' },
                },
              },
            }),
            mockServices.database.factory({ knex: db }),
            mockServices.auditor.mock().factory,
            mockServices.httpAuth.factory({
              defaultCredentials: mockCredentials.none(),
            }),
            createServiceFactory({
              service: actionsServiceRef,
              deps: {},
              factory: () => new FakeActions([]),
            }),
          ],
        }),
      ).rejects.toThrow(/one SQLite connection/);
    } finally {
      await db.destroy();
    }
  });

  it('refuses a request without credentials (401) and a service token (403)', async () => {
    const server = await startBackend();
    const none = await request(server).get('/api/ai-chat/sessions');
    const service = await request(server)
      .get('/api/ai-chat/sessions')
      .set('Authorization', mockCredentials.service.header());
    expect([none.status, service.status]).toEqual([401, 403]);
  });

  it('creates, lists, reads and deletes sessions of the user only', async () => {
    const server = await startBackend();
    const created = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice)
      .expect(201);
    expect(created.body).toMatchObject({
      id: expect.any(String),
      ownerRef: 'user:default/alice',
      enabledToolsets: ['default'],
    });
    const id = created.body.id;

    const list = await request(server)
      .get('/api/ai-chat/sessions')
      .set('Authorization', alice)
      .expect(200);
    expect(list.body.items.map((s: any) => s.id)).toEqual([id]);
    const bobList = await request(server)
      .get('/api/ai-chat/sessions')
      .set('Authorization', bob)
      .expect(200);
    expect(bobList.body.items).toEqual([]);

    await request(server)
      .get(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', bob)
      .expect(404);
    await request(server)
      .delete(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', bob)
      .expect(404);
    const detail = await request(server)
      .get(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', alice)
      .expect(200);
    expect(detail.body).toMatchObject({
      session: { id },
      items: [],
      awaitingDecision: [],
      resumable: false,
    });
    await request(server)
      .delete(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', alice)
      .expect(204);
    await request(server)
      .get(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', alice)
      .expect(404);
  });

  it('streams the answer of a message', async () => {
    const server = await startBackend();
    answers = [text('Hello there')];
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const res = await request(server)
      .post(`/api/ai-chat/sessions/${body.id}/runs`)
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
    const message = await readMessage(await parseSse(res.text));
    expect(message.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'Hello there', state: 'done' },
    ]);
    expect(llm.requests[0].body).toMatchObject({
      model: 'test-model',
      stream: true,
    });
  });

  it('answers a refused request with an error status, not a stream', async () => {
    const server = await startBackend();
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const url = `/api/ai-chat/sessions/${body.id}/runs`;
    await request(server)
      .post(url)
      .set('Authorization', alice)
      .send({ text: '' })
      .expect(400);
    const missing = await request(server)
      .post('/api/ai-chat/sessions/nope/runs')
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    await request(server)
      .post(url)
      .set('Authorization', bob)
      .send({ text: 'hi' })
      .expect(404);
  });

  it('runs a read-only action at once, and waits for approval of another', async () => {
    const server = await startBackend();
    answers = [
      call('demo_list-things', {}),
      text('One thing.'),
      call('demo_change-thing', { name: 'x' }),
      text('Changed.'),
    ];
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const base = `/api/ai-chat/sessions/${body.id}`;

    const first = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'list' });
    await readMessage(await parseSse(first.text));
    expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);

    const second = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'change x' });
    const chunks = await parseSse(second.text);
    const request1 = chunks.find(
      c => c.type === 'tool-approval-request',
    ) as any;
    expect(request1).toBeDefined();
    expect(actions.invocations).toHaveLength(1);
    const callId = request1.approvalId;

    // Someone else cannot decide.
    await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', bob)
      .send({ approved: true })
      .expect(404);
    expect(actions.invocations).toHaveLength(1);

    const approved = await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', alice)
      .send({ approved: true })
      .expect(200);
    const after = await parseSse(approved.text);
    expect(after.map(c => c.type)).toContain('tool-output-available');
    expect(after[after.length - 1]).toMatchObject({ type: 'finish' });
    expect(actions.invocations.map(i => [i.id, i.input])).toEqual([
      ['demo:list-things', {}],
      ['demo:change-thing', { name: 'x' }],
    ]);

    // Only once.
    const again = await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', alice)
      .send({ approved: true })
      .expect(200);
    expect(again.body).toEqual({ approved: true });
    expect(actions.invocations).toHaveLength(2);
    expect(auditEvents).toEqual(['tool-call-approve', 'tool-call-invoke']);
  });

  it('denies through the route', async () => {
    const server = await startBackend();
    answers = [call('demo_change-thing', { name: 'x' }), text('Not done.')];
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const base = `/api/ai-chat/sessions/${body.id}`;
    const first = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'change x' });
    const callId = (
      (await parseSse(first.text)).find(
        c => c.type === 'tool-approval-request',
      ) as any
    ).approvalId;
    const res = await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', alice)
      .send({ approved: false })
      .expect(200);
    expect((await parseSse(res.text)).map(c => c.type)).toContain(
      'tool-output-denied',
    );
    expect(actions.invocations).toEqual([]);
  });

  it('shows the user a fixed text, not the answer of the model server, when the model fails', async () => {
    const server = await startBackend(() => ({
      status: 500,
      type: 'application/json',
      body: '{"error":"down: key sk-live-12345 rejected"}',
    }));
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const res = await request(server)
      .post(`/api/ai-chat/sessions/${body.id}/runs`)
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(200);
    const chunks = await parseSse(res.text);
    expect(chunks.map(c => c.type).slice(-2)).toEqual(['data-run', 'error']);
    expect(chunks[chunks.length - 1]).toEqual({
      type: 'error',
      errorText: 'The model call failed.',
    });
    expect(res.text).not.toContain('sk-live');
    expect(res.text).not.toContain('down');
  });
});

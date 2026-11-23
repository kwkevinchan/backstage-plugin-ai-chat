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
import request from 'supertest';
import {
  createDb,
  FakeActions,
  LlmServer,
  sseBody,
  startLlmServer,
} from './__testUtils__';
import { aiChatPlugin } from './plugin';

/** The events of a `text/event-stream` body. */
function parseEvents(text: string) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(block => {
      const event = /^event: (.*)$/m.exec(block)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
      return { event, data };
    });
}

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
    llm = await startLlmServer(
      respond ??
        ((_body, index) => ({
          body: answers[Math.min(index, answers.length - 1)],
        })),
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

  it('creates, lists, reads and deletes conversations of the user only', async () => {
    const server = await startBackend();
    const created = await request(server)
      .post('/api/ai-chat/conversations')
      .set('Authorization', alice)
      .expect(201);
    expect(created.body).toMatchObject({
      id: expect.any(String),
      title: 'New conversation',
    });
    const id = created.body.id;

    const list = await request(server)
      .get('/api/ai-chat/conversations')
      .set('Authorization', alice)
      .expect(200);
    expect(list.body.items.map((c: any) => c.id)).toEqual([id]);
    const bobList = await request(server)
      .get('/api/ai-chat/conversations')
      .set('Authorization', bob)
      .expect(200);
    expect(bobList.body.items).toEqual([]);

    await request(server)
      .get(`/api/ai-chat/conversations/${id}`)
      .set('Authorization', bob)
      .expect(404);
    await request(server)
      .delete(`/api/ai-chat/conversations/${id}`)
      .set('Authorization', bob)
      .expect(404);
    const detail = await request(server)
      .get(`/api/ai-chat/conversations/${id}`)
      .set('Authorization', alice)
      .expect(200);
    expect(detail.body).toMatchObject({
      conversation: { id },
      messages: [],
      toolCalls: [],
    });
    await request(server)
      .delete(`/api/ai-chat/conversations/${id}`)
      .set('Authorization', alice)
      .expect(204);
    await request(server)
      .get(`/api/ai-chat/conversations/${id}`)
      .set('Authorization', alice)
      .expect(404);
  });

  it('refuses a service token', async () => {
    const server = await startBackend();
    const res = await request(server)
      .get('/api/ai-chat/conversations')
      .set('Authorization', mockCredentials.service.header());
    expect(res.status).toBe(403);
  });

  it('streams the answer of a message', async () => {
    const server = await startBackend();
    answers = [text('Hello there')];
    const { body } = await request(server)
      .post('/api/ai-chat/conversations')
      .set('Authorization', alice);
    const res = await request(server)
      .post(`/api/ai-chat/conversations/${body.id}/messages`)
      .set('Authorization', alice)
      .send({ content: 'hi' })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toContain('no-transform');
    const events = parseEvents(res.text);
    expect(events.map(e => e.event)).toEqual([
      'user_message',
      'text_delta',
      'assistant_message',
      'done',
    ]);
    expect(events[2].data.message).toMatchObject({
      role: 'assistant',
      content: 'Hello there',
    });
    expect(llm.requests[0].body).toMatchObject({
      model: 'test-model',
      stream: true,
    });
  });

  it('answers a refused request with an error status, not a stream', async () => {
    const server = await startBackend();
    const { body } = await request(server)
      .post('/api/ai-chat/conversations')
      .set('Authorization', alice);
    const url = `/api/ai-chat/conversations/${body.id}/messages`;
    await request(server)
      .post(url)
      .set('Authorization', alice)
      .send({ content: '' })
      .expect(400);
    await request(server)
      .post(url)
      .set('Authorization', alice)
      .send({})
      .expect(400);
    await request(server)
      .post(url)
      .set('Authorization', alice)
      .send({ content: 'a\u0000b' })
      .expect(400);
    await request(server)
      .post(url)
      .set('Authorization', alice)
      .send({ content: 'x'.repeat(9000) })
      .expect(400);
    const missing = await request(server)
      .post('/api/ai-chat/conversations/nope/messages')
      .set('Authorization', alice)
      .send({ content: 'hi' })
      .expect(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    await request(server)
      .post(url)
      .set('Authorization', bob)
      .send({ content: 'hi' })
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
      .post('/api/ai-chat/conversations')
      .set('Authorization', alice);
    const base = `/api/ai-chat/conversations/${body.id}`;

    const first = await request(server)
      .post(`${base}/messages`)
      .set('Authorization', alice)
      .send({ content: 'list' });
    expect(parseEvents(first.text).map(e => e.event)).toEqual([
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'text_delta',
      'assistant_message',
      'done',
    ]);
    expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);

    const second = await request(server)
      .post(`${base}/messages`)
      .set('Authorization', alice)
      .send({ content: 'change x' });
    const events = parseEvents(second.text);
    const approval = events.find(e => e.event === 'approval_required')!;
    expect(approval.data.toolCall).toMatchObject({
      actionId: 'demo:change-thing',
      status: 'pending_approval',
      input: { name: 'x' },
      attributes: { readOnly: false, destructive: true },
    });
    expect(actions.invocations).toHaveLength(1);
    const callId = approval.data.toolCall.id;

    // Someone else cannot decide.
    await request(server)
      .post(`${base}/tool-calls/${callId}/approve`)
      .set('Authorization', bob)
      .expect(404);
    expect(actions.invocations).toHaveLength(1);

    const approved = await request(server)
      .post(`${base}/tool-calls/${callId}/approve`)
      .set('Authorization', alice)
      .expect(200);
    expect(parseEvents(approved.text).map(e => e.event)).toEqual([
      'tool_call',
      'tool_result',
      'text_delta',
      'assistant_message',
      'done',
    ]);
    expect(actions.invocations.map(i => [i.id, i.input])).toEqual([
      ['demo:list-things', {}],
      ['demo:change-thing', { name: 'x' }],
    ]);

    // Only once.
    await request(server)
      .post(`${base}/tool-calls/${callId}/approve`)
      .set('Authorization', alice)
      .expect(409);
    await request(server)
      .post(`${base}/tool-calls/${callId}/reject`)
      .set('Authorization', alice)
      .expect(409);
    await request(server)
      .post(`${base}/tool-calls/nope/approve`)
      .set('Authorization', alice)
      .expect(404);
    expect(actions.invocations).toHaveLength(2);

    const detail = await request(server)
      .get(base)
      .set('Authorization', alice)
      .expect(200);
    expect(detail.body.toolCalls.map((c: any) => c.status)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    // Messages of the model API (role tool) are not part of the response.
    expect(
      detail.body.messages
        .map((m: any) => m.role)
        .filter((r: string) => r === 'tool'),
    ).toEqual([]);
    // The second approval and the rejection were refused (409) and are
    // recorded as failed attempts.
    expect(auditEvents).toEqual([
      'tool-call-approve',
      'tool-call-invoke',
      'tool-call-approve',
      'tool-call-reject',
    ]);
  });

  it('rejects through the route', async () => {
    const server = await startBackend();
    answers = [call('demo_change-thing', { name: 'x' }), text('Not done.')];
    const { body } = await request(server)
      .post('/api/ai-chat/conversations')
      .set('Authorization', alice);
    const base = `/api/ai-chat/conversations/${body.id}`;
    const first = await request(server)
      .post(`${base}/messages`)
      .set('Authorization', alice)
      .send({ content: 'change x' });
    const callId = parseEvents(first.text).find(
      e => e.event === 'approval_required',
    )!.data.toolCall.id;
    const res = await request(server)
      .post(`${base}/tool-calls/${callId}/reject`)
      .set('Authorization', alice)
      .expect(200);
    expect(parseEvents(res.text).map(e => e.event)).toEqual([
      'tool_result',
      'text_delta',
      'assistant_message',
      'done',
    ]);
    expect(actions.invocations).toEqual([]);
  });

  it('reports a failure of the model as an event', async () => {
    const server = await startBackend(() => ({
      status: 500,
      type: 'application/json',
      body: '{"error":"down"}',
    }));
    const { body } = await request(server)
      .post('/api/ai-chat/conversations')
      .set('Authorization', alice);
    const res = await request(server)
      .post(`/api/ai-chat/conversations/${body.id}/messages`)
      .set('Authorization', alice)
      .send({ content: 'hi' })
      .expect(200);
    const error = parseEvents(res.text).find(e => e.event === 'error')!;
    expect(error.data.message).toBe(
      'The model server answered 500: {"error":"down"}',
    );
  });
});

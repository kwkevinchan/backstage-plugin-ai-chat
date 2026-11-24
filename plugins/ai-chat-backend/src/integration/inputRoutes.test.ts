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

import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import type { ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  callTool,
  say,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../adapters/http';
import {
  parseSse,
  readMessage,
} from '../adapters/http/__testUtils__/uiMessageStream';
import { principalFromRequest } from '../adapters/backstage/principalFromRequest';
import { createWorld, until } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']> & { app: express.Express };

const JANE = mockCredentials.user.header('user:default/jane');
const MALLORY = mockCredentials.user.header('user:default/mallory');
const writeCall = callTool('m1', 'demo:write', { name: 'x' });

/**
 * The routes of the input phase (PI-03) on a real database, behind the error
 * handler of Backstage: the codes of status, the names of the errors, and the
 * streams read back with the parser of the AI SDK.
 */
describe('the routes of the inserted messages and the queue', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  beforeEach(async () => {
    world = await createWorld();
  });

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<World['backend']>): Backend {
    const b = world.backend(...args);
    open.push(b.supervisor);
    // No header: nobody is signed in.
    const httpAuth = mockServices.httpAuth({
      defaultCredentials: mockCredentials.none(),
    });
    const app = express()
      .use(
        createRouter({
          principal: req =>
            principalFromRequest(req, {
              httpAuth,
              userInfo: mockServices.userInfo(),
              auth: mockServices.auth(),
            }),
          useCases: b.useCases,
          logger: b.logger,
        }),
      )
      .use(
        MiddlewareFactory.create({
          config: mockServices.rootConfig(),
          logger: mockServices.rootLogger(),
        }).error(),
      );
    return { ...b, app };
  }

  const as = (user: string | undefined, test: request.Test) =>
    user ? test.set('Authorization', user) : test;

  async function newSession(b: Backend) {
    const res = await as(JANE, request(b.app).post('/sessions')).expect(201);
    return res.body.id as string;
  }

  /** A session with a run whose model call does not end, so inserts and queueing are possible. */
  async function blocked(b: Backend) {
    const id = await newSession(b);
    // The request stays open until the run ends, so it is not awaited.
    const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
      .send({ text: 'go' })
      .then(res => res);
    await until(() => b.model.inputs.length === 1);
    const runId = (await world.knex('runs').where({ session_id: id }).first())
      .id;
    return { id, runId, pending };
  }

  describe('the status codes and the names of the errors', () => {
    it('answers 401 without a user, 404 for another user, and 400 for a content that is not right, on every route', async () => {
      const b = backend([waitForAbort]);
      const { id, runId, pending } = await blocked(b);
      const queued = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/queue`),
      )
        .send({ text: 'later' })
        .expect(201);
      const qid = queued.body.id as string;

      const routes: [string, string, unknown][] = [
        ['post', `/sessions/${id}/runs/${runId}/messages`, { text: 'x' }],
        ['get', `/sessions/${id}/queue`, undefined],
        ['post', `/sessions/${id}/queue`, { text: 'x' }],
        ['patch', `/sessions/${id}/queue/${qid}`, { text: 'x' }],
        ['delete', `/sessions/${id}/queue/${qid}`, undefined],
        ['put', `/sessions/${id}/queue/order`, { ids: [qid] }],
        ['post', `/sessions/${id}/queue/resume`, undefined],
      ];
      for (const [method, path, body] of routes) {
        const call = (user?: string) =>
          as(user, (request(b.app) as any)[method](path)).send(body as any);
        expect([method, path, (await call()).status]).toEqual([
          method,
          path,
          401,
        ]);
        expect([method, path, (await call(MALLORY)).status]).toEqual([
          method,
          path,
          404,
        ]);
      }

      const bad: [string, string, unknown][] = [
        ['post', `/sessions/${id}/runs/${runId}/messages`, {}],
        ['post', `/sessions/${id}/runs/${runId}/messages`, { text: '   ' }],
        [
          'post',
          `/sessions/${id}/runs/${runId}/messages`,
          { text: 'x'.repeat(8001) },
        ],
        ['post', `/sessions/${id}/queue`, { text: '' }],
        [
          'post',
          `/sessions/${id}/queue`,
          { text: 'x', page: { path: 'no slash' } },
        ],
        ['patch', `/sessions/${id}/queue/${qid}`, {}],
        ['patch', `/sessions/${id}/queue/${qid}`, { text: '' }],
        ['put', `/sessions/${id}/queue/order`, {}],
        ['put', `/sessions/${id}/queue/order`, { ids: [1] }],
      ];
      for (const [method, path, body] of bad) {
        const res = await as(JANE, (request(b.app) as any)[method](path)).send(
          body as any,
        );
        expect([method, path, body, res.status]).toEqual([
          method,
          path,
          body,
          400,
        ]);
      }
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });
  });

  describe('POST /sessions/:id/runs/:runId/messages', () => {
    it('writes the message and answers 201 with the item; the session shows it as pending, then unread', async () => {
      const b = backend([waitForAbort]);
      const { id, runId, pending } = await blocked(b);
      const res = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/messages`),
      )
        .send({ text: 'use staging', page: { path: '/catalog/x' } })
        .expect(201);
      expect(res.body).toMatchObject({
        kind: 'user_message',
        text: 'use staging',
        delivery: 'inserted',
        runId,
        page: { path: '/catalog/x' },
      });

      const during = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      const item = during.body.items.find(
        (i: any) => i.delivery === 'inserted',
      );
      expect(item.insertState).toBe('pending');
      expect(
        during.body.items.find((i: any) => i.delivery === undefined)
          .insertState,
      ).toBeUndefined();

      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
      const after = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(
        after.body.items.find((i: any) => i.delivery === 'inserted')
          .insertState,
      ).toBe('unread');
    });

    it('answers 409 with the name of the error: RunNotRunning for a run that is not running, InsertLimitReached for the sixth', async () => {
      const b = backend([waitForAbort]);
      const { id, runId, pending } = await blocked(b);
      const post = (text: string, run = runId) =>
        as(
          JANE,
          request(b.app).post(`/sessions/${id}/runs/${run}/messages`),
        ).send({
          text,
        });
      expect((await post('x', 'other-run').expect(409)).body.error.name).toBe(
        'RunNotRunning',
      );
      for (let i = 1; i <= 5; i++) await post(`m${i}`).expect(201);
      expect((await post('m6').expect(409)).body.error.name).toBe(
        'InsertLimitReached',
      );
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
      expect((await post('late').expect(409)).body.error.name).toBe(
        'RunNotRunning',
      );
    });

    it('streams data-inserted for a message the model read, part of the assistant message, and the SDK reads it back', async () => {
      let done = false;
      const b: Backend = backend([[say('first')], [say('second')]], {
        items: (inner: ItemLog) => ({
          read: (...args) => inner.read(...args),
          append: async (sessionId, drafts, fence) => {
            if (!done && drafts.some(d => d.kind === 'agent_message')) {
              done = true;
              await as(
                JANE,
                request(b.app).post(
                  `/sessions/${sessionId}/runs/${fence.runId}/messages`,
                ),
              )
                .send({ text: 'and check the logs' })
                .expect(201);
            }
            return inner.append(sessionId, drafts, fence);
          },
        }),
      });
      const id = await newSession(b);
      const res = await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'deploy' })
        .expect(200);
      const chunks = await parseSse(res.text);
      const message = await readMessage(chunks);
      expect(message.parts.map(p => p.type)).toEqual([
        'step-start',
        'text',
        'data-inserted',
        'step-start',
        'text',
      ]);
      expect(message.parts[2]).toMatchObject({
        type: 'data-inserted',
        data: { text: 'and check the logs' },
      });
    });
  });

  describe('the queue', () => {
    it('lists, adds, changes, removes and orders the messages, and answers the state of the queue', async () => {
      const b = backend([waitForAbort]);
      const { id, runId, pending } = await blocked(b);
      const queue = (path = '') => `/sessions/${id}/queue${path}`;

      const first = await as(JANE, request(b.app).post(queue()))
        .send({ text: 'one', page: { path: '/a' } })
        .expect(201);
      expect(first.body).toEqual({
        id: expect.any(String),
        position: 1,
        text: 'one',
        page: { path: '/a' },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      const second = await as(JANE, request(b.app).post(queue()))
        .send({ text: 'two' })
        .expect(201);
      expect(
        (await as(JANE, request(b.app).get(queue())).expect(200)).body,
      ).toEqual({
        items: [first.body, second.body],
        paused: false,
      });

      const changed = await as(
        JANE,
        request(b.app).patch(queue(`/${first.body.id}`)),
      )
        .send({ text: 'one!', page: null })
        .expect(200);
      expect(changed.body).toMatchObject({ text: 'one!', position: 1 });
      expect(changed.body.page).toBeUndefined();

      const ordered = await as(JANE, request(b.app).put(queue('/order')))
        .send({ ids: [second.body.id, first.body.id] })
        .expect(200);
      expect(ordered.body.items.map((m: any) => [m.position, m.text])).toEqual([
        [1, 'two'],
        [2, 'one!'],
      ]);
      await as(JANE, request(b.app).delete(queue(`/${second.body.id}`))).expect(
        204,
      );

      // The detail of the session has the queue too.
      const detail = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(detail.body.queue.items.map((m: any) => m.text)).toEqual(['one!']);

      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
      expect(
        (await as(JANE, request(b.app).get(queue())).expect(200)).body.paused,
      ).toBe(true);
    });

    it('answers 409 NoActiveRun, QueueFull and QueueChanged, and 404 QueuedMessageNotFound, with the names', async () => {
      const b = backend([waitForAbort]);
      const idle = await newSession(b);
      expect(
        (
          await as(JANE, request(b.app).post(`/sessions/${idle}/queue`))
            .send({ text: 'x' })
            .expect(409)
        ).body.error.name,
      ).toBe('NoActiveRun');

      const { id, runId, pending } = await blocked(b);
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const res = await as(JANE, request(b.app).post(`/sessions/${id}/queue`))
          .send({ text: `m${i}` })
          .expect(201);
        ids.push(res.body.id);
      }
      expect(
        (
          await as(JANE, request(b.app).post(`/sessions/${id}/queue`))
            .send({ text: 'm6' })
            .expect(409)
        ).body.error.name,
      ).toBe('QueueFull');

      await as(
        JANE,
        request(b.app).delete(`/sessions/${id}/queue/${ids[0]}`),
      ).expect(204);
      expect(
        (
          await as(JANE, request(b.app).put(`/sessions/${id}/queue/order`))
            .send({ ids })
            .expect(409)
        ).body.error.name,
      ).toBe('QueueChanged');
      const gone = await as(
        JANE,
        request(b.app).patch(`/sessions/${id}/queue/${ids[0]}`),
      )
        .send({ text: 'x' })
        .expect(404);
      expect(gone.body.error.name).toBe('QueuedMessageNotFound');
      await as(
        JANE,
        request(b.app).delete(`/sessions/${id}/queue/${ids[0]}`),
      ).expect(404);

      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });

    it('POST /queue/resume: streams the run of the first message when the queue is paused, and answers 204 when the queue is empty or a run goes on', async () => {
      const b = backend([waitForAbort, [say('the queued answer')]]);
      const { id, runId, pending } = await blocked(b);
      await as(JANE, request(b.app).post(`/sessions/${id}/queue`))
        .send({ text: 'send me' })
        .expect(201);
      // A run goes on: nothing to send.
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/queue/resume`),
      ).expect(204);

      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
      const res = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/queue/resume`),
      ).expect(200);
      const message = await readMessage(await parseSse(res.text));
      expect(message.parts).toContainEqual({
        type: 'text',
        text: 'the queued answer',
        state: 'done',
      });
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/queue/resume`),
      ).expect(204);
    });

    it('sends data-queue before data-run at the end of a run, with the id of the run the queue started; the SDK reads it back', async () => {
      const b = backend([[writeCall], [say('done')], [say('next answer')]]);
      const id = await newSession(b);
      const first = await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'deploy' })
        .expect(200);
      const call = (await parseSse(first.text)).find(
        c => c.type === 'tool-approval-request',
      ) as { approvalId: string };
      await as(JANE, request(b.app).post(`/sessions/${id}/queue`))
        .send({ text: 'and then' })
        .expect(201);

      const res = await as(
        JANE,
        request(b.app).post(
          `/sessions/${id}/tool-calls/${call.approvalId}/decision`,
        ),
      )
        .send({ approved: true })
        .expect(200);
      const chunks = await parseSse(res.text);
      const at = (type: string, from = 0) =>
        chunks.findIndex((c, i) => i >= from && c.type === type);
      const queueAt = at('data-queue');
      expect(queueAt).toBeGreaterThan(-1);
      // Before the last state of the run, which comes before `finish`.
      expect(queueAt).toBeLessThan(
        chunks.map(c => c.type).lastIndexOf('data-run'),
      );
      expect(chunks[queueAt]).toMatchObject({
        type: 'data-queue',
        transient: true,
        data: {
          paused: false,
          items: [],
          nextRunId: expect.any(String),
        },
      });
      const next = (chunks[queueAt] as any).data.nextRunId;
      await until(
        async () => (await world.runRow(next)).status === 'completed',
      );
    });
  });
});

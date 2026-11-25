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
import {
  callTool,
  say,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createRouter } from '../adapters/http';
import { parseSse } from '../adapters/http/__testUtils__/uiMessageStream';
import { principalFromRequest } from '../adapters/backstage/principalFromRequest';
import {
  createWorld,
  jane,
  janeFresh,
  testInputConfig,
  until,
} from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']>;

const JANE = mockCredentials.user.header('user:default/jane');
const writeCall = callTool('m1', 'demo:write', { name: 'x' });
const readCall = callTool('m1', 'demo:read', { name: 'x' });

/**
 * Two backends on one database: the deployment of P1 with more than one
 * replica. Each backend has its own host, its own `RunSupervisor` and its own
 * model; they share the database and nothing else. The clock is shared and
 * moved by hand, so the leases lapse when a test says so.
 */
describe('two backends on one database', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];
  const servers: Server[] = [];

  beforeEach(async () => {
    world = await createWorld();
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<World['backend']>) {
    const b = world.backend(...args);
    open.push(b.supervisor);
    return b;
  }

  function app(host: Backend) {
    const httpAuth = mockServices.httpAuth();
    const userInfo = mockServices.userInfo();
    const auth = mockServices.auth();
    return express()
      .use(
        createRouter({
          principal: req =>
            principalFromRequest(req, { httpAuth, userInfo, auth }),
          useCases: host.useCases,
          inputConfig: testInputConfig,
          logger: host.logger,
        }),
      )
      .use(
        MiddlewareFactory.create({
          config: mockServices.rootConfig(),
          logger: mockServices.rootLogger(),
        }).error(),
      );
  }

  async function listen(application: express.Express) {
    const server = createServer(application);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** A message that runs on `host` until the model call is under way. */
  async function startRun(host: Backend, text = 'go') {
    const session = await world.newSession();
    const handle = await host.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text,
    });
    await until(() => host.model.inputs.length === 1);
    return { session, handle };
  }

  /** A message whose run stops at a tool that needs an approval. */
  async function waitingRun(host: Backend) {
    const session = await world.newSession();
    const handle = await host.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'go',
    });
    for await (const _event of handle.events) {
      // Reads the run to its end: it waits for the approval.
    }
    await handle.done;
    const [call] = (await world.items.read(session.id)).filter(
      item => item.kind === 'tool_call',
    );
    return { session, handle, callId: (call as { callId: string }).callId };
  }

  describe('an approval that the other backend receives (H-01, H-04, A-06, T-07)', () => {
    it('lets B carry the run on and run the tool once, while A holds nothing', async () => {
      const a = backend([[writeCall]]);
      const b = backend([[say('written')]]);
      const { session, handle, callId } = await waitingRun(a);
      expect((await world.runRow(handle.runId)).status).toBe(
        'waiting_approval',
      );
      expect(a.supervisor.activeRunIds()).toEqual([]);
      expect(world.actions.count('demo:write')).toBe(0);

      const decided = await b.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId,
        decision: 'allow',
      });
      for await (const _event of decided.run!.events) {
        // The loop of B runs to its end.
      }
      await decided.run!.done;

      expect(world.actions.count('demo:write')).toBe(1);
      expect((await world.runRow(handle.runId)).status).toBe('completed');
      // B did the work; A never called its model again.
      expect(b.model.inputs).toHaveLength(1);
      expect(a.model.inputs).toHaveLength(1);
      const items = await world.items.read(session.id);
      expect(items.map(item => item.kind)).toEqual([
        'user_message',
        'tool_call',
        'approval',
        'tool_started',
        'tool_result',
        'agent_message',
      ]);
    });

    it('runs the tool once when both backends get the same decision at the same time', async () => {
      const a = backend([[writeCall], [say('a took it')]]);
      const b = backend([[say('b took it')]]);
      const { session, handle, callId } = await waitingRun(a);

      const decide = (host: Backend) =>
        host.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId,
          decision: 'allow',
        });
      const [fromA, fromB] = await Promise.all([decide(a), decide(b)]);
      const runs = [fromA.run, fromB.run].filter(Boolean);
      // Only one request starts the loop.
      expect(runs).toHaveLength(1);
      for await (const _event of runs[0]!.events) {
        // Reads to the end.
      }
      await runs[0]!.done;

      expect(world.actions.count('demo:write')).toBe(1);
      expect((await world.runRow(handle.runId)).status).toBe('completed');
      const approvals = (await world.items.read(session.id)).filter(
        item => item.kind === 'approval',
      );
      expect(approvals).toHaveLength(1);
    });

    it('does the same through the routes: the decision that B receives streams the rest of the run', async () => {
      const a = backend([[writeCall]]);
      const b = backend([[say('written by b')]]);
      const applicationA = app(a);
      const applicationB = app(b);
      const created = await request(applicationA)
        .post('/sessions')
        .set('Authorization', JANE)
        .expect(201);
      const id = created.body.id as string;
      const first = await request(applicationA)
        .post(`/sessions/${id}/runs`)
        .set('Authorization', JANE)
        .send({ text: 'go' })
        .expect(200);
      const requested = (await parseSse(first.text)).find(
        chunk => chunk.type === 'tool-approval-request',
      ) as { approvalId: string };
      expect(requested).toBeDefined();

      const second = await request(applicationB)
        .post(`/sessions/${id}/tool-calls/${requested.approvalId}/decision`)
        .set('Authorization', JANE)
        .send({ approved: true })
        .expect(200);
      const chunks = await parseSse(second.text);
      expect(chunks[1]).toMatchObject({
        type: 'tool-approval-response',
        approved: true,
      });
      expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true);
      expect(world.actions.count('demo:write')).toBe(1);
    });
  });

  describe('the shutdown of one backend (H-11)', () => {
    it('ends only the runs of that backend', async () => {
      const a = backend([waitForAbort]);
      const b = backend([waitForAbort]);
      const onA = await startRun(a, 'on a');
      const onB = await startRun(b, 'on b');
      const waiting = await waitingRun(backend([[writeCall]]));

      await a.supervisor.shutdown(30);
      await onA.handle.done;

      const ended = await world.runRow(onA.handle.runId);
      expect(ended.status).toBe('expired');
      expect(ended.end_reason).toBe('shutdown');
      expect(ended.active_session_id).toBeNull();

      // The run of B is still its own, with its lease and its loop.
      const other = await world.runRow(onB.handle.runId);
      expect(other.status).toBe('running');
      expect(other.active_session_id).toBe(onB.session.id);
      expect(b.supervisor.activeRunIds()).toEqual([onB.handle.runId]);
      // A run that waits for an approval is nobody's, and stays.
      expect((await world.runRow(waiting.handle.runId)).status).toBe(
        'waiting_approval',
      );
      expect((await world.runningRows()).map(row => row.id)).toEqual([
        onB.handle.runId,
      ]);

      // B goes on to the end of its own run.
      await b.supervisor.shutdown(30);
      await onB.handle.done;
      expect((await world.runRow(onB.handle.runId)).status).toBe('expired');
    });
  });

  describe('a backend that stops without a shutdown (H-04, A-06)', () => {
    it('is expired by ExpireStaleRuns on the other backend, and the session takes a new run', async () => {
      const crashed = backend([waitForAbort]);
      const b = backend([[say('again')]]);
      const { session, handle } = await startRun(crashed);

      // The lease is still good: B leaves the run alone.
      expect(await b.useCases.expireStaleRuns.execute()).toEqual([]);
      expect((await world.runRow(handle.runId)).status).toBe('running');
      await expect(
        b.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'too early',
        }),
      ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });

      // `crashed` renews nothing and never calls `shutdown`.
      world.clock.advance(31);
      expect(await b.useCases.expireStaleRuns.execute()).toEqual([
        handle.runId,
      ]);
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('expired');
      expect(row.active_session_id).toBeNull();

      const next = await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'again',
      });
      for await (const _event of next.events) {
        // Reads to the end.
      }
      await next.done;
      expect((await world.runRow(next.runId)).status).toBe('completed');
      expect((await world.runRow(handle.runId)).status).toBe('expired');
    });
  });

  describe('GET /sessions/:id/stream on the backend that does not run the loop (P1 limit)', () => {
    it('answers 204 there, and sends the run on the backend that runs it', async () => {
      const a = backend([waitForAbort]);
      const b = backend([]);
      const baseA = await listen(app(a));
      const baseB = await listen(app(b));
      const { session, handle } = await startRun(a);

      const onB = await fetch(`${baseB}/sessions/${session.id}/stream`, {
        headers: { Authorization: JANE },
      });
      expect(onB.status).toBe(204);

      const onA = await fetch(`${baseA}/sessions/${session.id}/stream`, {
        headers: { Authorization: JANE },
      });
      expect(onA.status).toBe(200);
      await onA.body!.cancel();
      expect((await world.runRow(handle.runId)).status).toBe('running');
    });
  });

  describe('inserted messages and the queue across backends (PI-03)', () => {
    it('lets B read a message that was inserted before A put the run to wait: B takes the run over after the approval and its model call has the message', async () => {
      let sessionId = '';
      const a: Backend = backend([[writeCall]], {
        aroundTransition: async (info, call) => {
          if (info.to === 'waiting_approval') {
            // The insert goes to whichever backend gets it; here it is A.
            await a.useCases.insertMessage.execute({
              principal: jane,
              sessionId,
              runId: info.runId,
              text: 'to staging only',
            });
          }
          return call();
        },
      });
      const b = backend([[say('written')]]);
      const session = await world.newSession();
      sessionId = session.id;
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId,
        text: 'deploy',
      });
      for await (const _event of handle.events) {
        // Reads the run to its end: it waits for the approval.
      }
      await handle.done;
      const call = (await world.items.read(session.id)).find(
        item => item.kind === 'tool_call',
      ) as { callId: string };

      const decided = await b.useCases.decideApproval.execute({
        principal: jane,
        sessionId,
        callId: call.callId,
        decision: 'allow',
      });
      for await (const _event of decided.run!.events) {
        // The loop of B runs to its end.
      }
      await decided.run!.done;

      expect((await world.runRow(handle.runId)).status).toBe('completed');
      expect(b.model.inputs).toHaveLength(1);
      expect(
        b.model.inputs[0].messages
          .filter(m => m.role === 'user')
          .map(m => m.content),
      ).toEqual(['deploy', 'to staging only']);
      expect(a.model.inputs).toHaveLength(1);
    });

    it('starts the next run of the queue with the identity of B, which made the last approval, and A sends nothing', async () => {
      const a = backend([[writeCall]]);
      const b = backend([[say('written')], [readCall], [say('read it')]]);
      const identityOfB = {
        ...janeFresh,
        credentials: { marker: 'request that reached B' },
      };
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: janeFresh,
        sessionId: session.id,
        text: 'deploy',
      });
      for await (const _event of handle.events) {
        // Reads the run to its end: it waits for the approval.
      }
      await handle.done;
      await a.useCases.queueMessage.execute({
        principal: janeFresh,
        sessionId: session.id,
        text: 'then read it',
      });
      const call = (await world.items.read(session.id)).find(
        item => item.kind === 'tool_call',
      ) as { callId: string };

      const decided = await b.useCases.decideApproval.execute({
        principal: identityOfB,
        sessionId: session.id,
        callId: call.callId,
        decision: 'allow',
      });
      const events = [];
      for await (const event of decided.run!.events) events.push(event);
      await decided.run!.done;

      const state = events.find(e => e.type === 'queue.state') as any;
      expect(state.nextRunId).toEqual(expect.any(String));
      await until(
        async () =>
          (await world.runRow(state.nextRunId)).status === 'completed',
      );
      // A ran the first loop and has nothing to do with the end.
      expect(a.model.inputs).toHaveLength(1);
      expect(b.model.inputs).toHaveLength(3);
      const read = world.actions.invocations.find(i => i.id === 'demo:read');
      expect(read?.credentials).toBe(identityOfB.credentials);
      expect(
        (await world.items.read(session.id)).filter(
          item => item.kind === 'user_message' && item.delivery === 'queued',
        ),
      ).toHaveLength(1);
    });
  });

  describe('turning a queued message into an insert across backends (IN-20)', () => {
    it('lets B turn a queued message into an insert while A runs the loop, and A reads it', async () => {
      let moved = false;
      const b = backend([]);
      const a: Backend = backend(
        [[readCall], [say('got insert')], [say('got queued')]],
        {
          items: inner => ({
            read: (...args) => inner.read(...args),
            append: async (sessionId, drafts, fence) => {
              if (!moved && drafts.some(d => d.kind === 'tool_call')) {
                moved = true;
                const qNow = await b.useCases.queueMessage.execute({
                  principal: janeFresh,
                  sessionId,
                  text: 'send me now',
                });
                await b.useCases.queueMessage.execute({
                  principal: janeFresh,
                  sessionId,
                  text: 'stay queued',
                });
                await b.useCases.insertQueuedMessage.execute({
                  principal: janeFresh,
                  sessionId,
                  queuedId: qNow.id,
                  runId: fence.runId,
                });
              }
              return inner.append(sessionId, drafts, fence);
            },
          }),
        },
      );
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: janeFresh,
        sessionId: session.id,
        text: 'start',
      });
      for await (const _event of handle.events) {
        // Reads to the end.
      }
      await handle.done;
      await until(
        async () =>
          (
            await world
              .knex('runs')
              .where({ session_id: session.id })
              .whereNotNull('active_session_id')
          ).length === 0,
      );

      expect(
        a.model.inputs[1].messages
          .filter(m => m.role === 'user')
          .map(m => m.content),
      ).toEqual(['start', 'send me now']);
      const items = await world.items.read(session.id);
      expect(
        items
          .filter(i => i.kind === 'user_message')
          .map(i => [(i as any).text, (i as any).delivery]),
      ).toEqual([
        ['start', undefined],
        ['send me now', 'inserted'],
        ['stay queued', 'queued'],
      ]);
    });
  });
});

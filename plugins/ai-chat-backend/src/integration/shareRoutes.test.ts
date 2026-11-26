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
import { callTool, say } from '@kwkevinchan/ai-chat-harness/testing';
import type { ModelChunk, ModelClient } from '@kwkevinchan/ai-chat-harness';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createRouter } from '../adapters/http';
import { parseSse } from '../adapters/http/__testUtils__/uiMessageStream';
import { TITLE_PROMPT_MARK } from '../application';
import { IMAGES } from '../__testUtils__/images';
import type { Principal } from '../domain';
import { createWorld, testInputConfig, until } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']> & { app: express.Express };

const HOUR = 3600;
const read = (name = 'x') => [callTool('m1', 'demo:read', { name })];
const write = (name = 'x') => [callTool('m1', 'demo:write', { name })];
const SHARE_EVENTS = [
  'session-share',
  'session-share-update',
  'session-share-revoke',
];

/**
 * The routes of the shares (P2-04) and what a sharee reaches through every
 * route, on a real database behind the error handler of Backstage. The user
 * of a request is the `x-user` header; `groups` says who is in which group,
 * so a test can take someone out of a group.
 */
describe('sharing a session', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];
  const groups = new Map<string, string[]>();
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    groups.clear();
    await world.cleanup();
  });

  function principalOf(name: string): Principal {
    const userRef = `user:default/${name}`;
    return {
      userRef,
      ownershipRefs: [userRef, ...(groups.get(name) ?? [])],
      credentials: mockCredentials.user(userRef),
    };
  }

  async function start(
    script: Parameters<World['backend']>[0],
    options: Parameters<typeof createWorld>[0] = {},
    extra: Parameters<World['backend']>[1] = {},
  ): Promise<Backend> {
    world = await createWorld(options);
    return backend(script, extra);
  }

  function backend(
    script: Parameters<World['backend']>[0],
    extra: Parameters<World['backend']>[1] = {},
  ): Backend {
    const b = world.backend(script, extra);
    open.push(b.supervisor);
    const app = express()
      .use(
        createRouter({
          principal: async req => principalOf(req.header('x-user') ?? ''),
          useCases: b.useCases,
          inputConfig: testInputConfig,
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

  const as = (user: string, test: request.Test) => test.set('x-user', user);

  async function newSession(b: Backend) {
    return (await as('jane', request(b.app).post('/sessions')).expect(201)).body
      .id as string;
  }

  async function send(b: Backend, id: string, text: string, extra = {}) {
    await as('jane', request(b.app).post(`/sessions/${id}/runs`))
      .send({ text, ...extra })
      .expect(200);
  }

  const share = (b: Backend, id: string, body: object, user = 'jane') =>
    as(user, request(b.app).post(`/sessions/${id}/shares`)).send(body);

  const items = async (b: Backend, id: string, user = 'bob', query = {}) =>
    (
      await as(user, request(b.app).get(`/sessions/${id}`))
        .query(query)
        .expect(200)
    ).body.items as any[];

  const shareEvents = () =>
    world.audit.events.filter(event => SHARE_EVENTS.includes(event.eventId));

  async function upload(b: Backend, id: string, type: keyof typeof IMAGES) {
    const res = await as(
      'jane',
      request(b.app)
        .post(`/sessions/${id}/attachments`)
        .query({ name: 'shot' })
        .set('Content-Type', type),
    )
      .send(IMAGES[type])
      .expect(201);
    return res.body.id as string;
  }

  describe('making, listing, changing and cancelling a share', () => {
    it('shares a snapshot that stops at that moment until the owner refreshes it (SH-01, SH-08)', async () => {
      const b = await start([[say('one')], [say('two')]]);
      const id = await newSession(b);
      await send(b, id, 'first');
      const before = await items(b, id, 'jane');
      const atSeq = before[before.length - 1].seq;

      const created = await share(b, id, {
        subjectRef: 'user:default/bob',
      }).expect(201);
      expect(created.body).toEqual({
        id: expect.any(String),
        subjectRef: 'user:default/bob',
        mode: 'snapshot',
        upToSeq: atSeq,
        expired: false,
        createdBy: 'user:default/jane',
        createdAt: expect.any(String),
      });
      await send(b, id, 'second');
      expect(await items(b, id)).toEqual(before);
      // The seq of a later item does not reach past the snapshot.
      expect(await items(b, id, 'bob', { afterSeq: atSeq })).toEqual([]);
      expect(await items(b, id, 'bob', { afterSeq: 0 })).toEqual(before);

      const refreshed = await as(
        'jane',
        request(b.app).patch(`/sessions/${id}/shares/${created.body.id}`),
      )
        .send({ refresh: true })
        .expect(200);
      const all = await items(b, id, 'jane');
      expect(refreshed.body.upToSeq).toBe(all[all.length - 1].seq);
      expect(await items(b, id)).toEqual(all);
    });

    it('lists the shares that are not cancelled for the owner only, and a stop takes one off (SH-10)', async () => {
      const b = await start([]);
      const id = await newSession(b);
      const live = await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
      }).expect(201);
      world.clock.advance(1);
      const team = await share(b, id, {
        subjectRef: 'group:default/team',
      }).expect(201);
      const list = await as(
        'jane',
        request(b.app).get(`/sessions/${id}/shares`),
      ).expect(200);
      expect(list.body.items).toEqual([live.body, team.body]);
      expect(live.body).toMatchObject({
        mode: 'live',
        outputsUpToSeq: 0,
        expiresAt: '2026-01-02T00:00:00.000Z',
        expired: false,
      });
      expect(live.body.upToSeq).toBeUndefined();

      await as('bob', request(b.app).get(`/sessions/${id}/shares`)).expect(404);
      await as(
        'jane',
        request(b.app).delete(`/sessions/${id}/shares/${live.body.id}`),
      ).expect(204);
      const after = await as(
        'jane',
        request(b.app).get(`/sessions/${id}/shares`),
      ).expect(200);
      expect(after.body.items).toEqual([team.body]);
    });

    it('writes each change to the auditor, and nothing for a refused request (SH-06)', async () => {
      const b = await start([]);
      const id = await newSession(b);
      await share(b, id, { subjectRef: 'user:default/bob' }, 'mallory').expect(
        404,
      );
      await share(b, id, { subjectRef: 'component:default/x' }).expect(400);
      expect(shareEvents()).toEqual([]);

      const created = await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
        hours: 2,
      }).expect(201);
      const shareId = created.body.id;
      await as(
        'jane',
        request(b.app).patch(`/sessions/${id}/shares/${shareId}`),
      )
        .send({ includeLaterToolOutputs: true })
        .expect(200);
      await as(
        'jane',
        request(b.app).delete(`/sessions/${id}/shares/${shareId}`),
      ).expect(204);
      await as(
        'jane',
        request(b.app).delete(`/sessions/${id}/shares/${shareId}`),
      ).expect(404);

      const common = {
        actorRef: 'user:default/jane',
        sessionId: id,
        shareId,
        subjectRef: 'user:default/bob',
        mode: 'live',
        expiresAt: '2026-01-01T02:00:00.000Z',
        outcome: 'success',
      };
      expect(shareEvents()).toEqual([
        { ...common, eventId: 'session-share', outputsUpToSeq: 0 },
        { ...common, eventId: 'session-share-update' },
        { ...common, eventId: 'session-share-revoke' },
      ]);
    });

    it('refuses a request that does not fit, and stores nothing', async () => {
      const b = await start([]);
      const id = await newSession(b);
      const refused = async (body: object, name = 'InvalidShare') => {
        const res = await share(b, id, body).expect(400);
        expect(res.body.error.name).toBe(name);
      };
      await refused({ subjectRef: 'component:default/x' });
      await refused({ subjectRef: 'user:default/a/b' });
      await refused({ subjectRef: 'user:default/jane' });
      await refused({ subjectRef: 'user:bob', hours: 2 });
      await refused({ subjectRef: 'user:bob', includeLaterToolOutputs: true });
      await refused({
        subjectRef: 'user:bob',
        mode: 'live',
        includeToolOutputs: false,
        includeLaterToolOutputs: true,
      });
      await refused({ subjectRef: 'user:bob', mode: 'live', hours: 73 });
      await refused(
        { subjectRef: 'user:bob', mode: 'live', hours: 0 },
        'InputError',
      );
      await refused({ subjectRef: 'user:bob', mode: 'forever' }, 'InputError');
      const list = await as(
        'jane',
        request(b.app).get(`/sessions/${id}/shares`),
      ).expect(200);
      expect(list.body.items).toEqual([]);

      const live = await share(b, id, {
        subjectRef: 'user:bob',
        mode: 'live',
      }).expect(201);
      expect(live.body.subjectRef).toBe('user:default/bob');
      const patch = (body: object) =>
        as(
          'jane',
          request(b.app).patch(`/sessions/${id}/shares/${live.body.id}`),
        ).send(body);
      await patch({}).expect(400);
      expect((await patch({ refresh: true }).expect(400)).body.error.name).toBe(
        'InvalidShare',
      );
      await as('jane', request(b.app).patch(`/sessions/${id}/shares/missing`))
        .send({ refresh: true })
        .expect(404);
      expect(shareEvents().map(event => event.eventId)).toEqual([
        'session-share',
      ]);
    });
  });

  describe('what the sharee sees', () => {
    it('sees the tool output of a snapshot unless the owner leaves it out (SH-02)', async () => {
      const b = await start([read(), [say('done')]]);
      const id = await newSession(b);
      await send(b, id, 'look');
      await share(b, id, { subjectRef: 'user:default/bob' }).expect(201);
      await share(b, id, {
        subjectRef: 'user:default/cara',
        includeToolOutputs: false,
      }).expect(201);

      const bob = await items(b, id);
      expect(bob.find(item => item.kind === 'tool_result')).toMatchObject({
        status: 'ok',
        output: { things: ['a'] },
      });
      const cara = await items(b, id, 'cara');
      expect(cara.find(item => item.kind === 'tool_result')).toEqual(
        expect.objectContaining({ status: 'ok', output: 'not shared' }),
      );
      expect(cara.find(item => item.kind === 'tool_call')).toMatchObject({
        toolId: 'demo:read',
        input: { name: 'x' },
      });
      expect(JSON.stringify(cara)).not.toContain('things');
    });

    it('hides the later tool output of a live share until the owner shows it (SH-09)', async () => {
      const b = await start([read('one'), [say('a')], read('two'), [say('b')]]);
      const id = await newSession(b);
      await send(b, id, 'first');
      const created = await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
      }).expect(201);
      await send(b, id, 'second');

      const results = (list: any[]) =>
        list.filter(item => item.kind === 'tool_result').map(r => r.output);
      expect(results(await items(b, id))).toEqual([
        { things: ['a'] },
        'not shared',
      ]);
      const calls = (await items(b, id)).filter(i => i.kind === 'tool_call');
      expect(calls.map(call => call.input)).toEqual([
        { name: 'one' },
        { name: 'two' },
      ]);

      await as(
        'jane',
        request(b.app).patch(`/sessions/${id}/shares/${created.body.id}`),
      )
        .send({ includeLaterToolOutputs: true })
        .expect(200);
      expect(results(await items(b, id))).toEqual([
        { things: ['a'] },
        { things: ['a'] },
      ]);
    });

    it('a group share is read by its members only, and not after one leaves (section 5)', async () => {
      const b = await start([]);
      const id = await newSession(b);
      groups.set('cara', ['group:default/team']);
      await share(b, id, { subjectRef: 'group:default/team' }).expect(201);
      const statusFor = async (user: string) =>
        (await as(user, request(b.app).get(`/sessions/${id}`))).status;
      expect(await statusFor('cara')).toBe(200);
      expect(await statusFor('mallory')).toBe(404);
      groups.delete('cara');
      expect(await statusFor('cara')).toBe(404);
    });

    it('a cancelled share stops every read at once, and cannot be changed (section 5)', async () => {
      const b = await start([[say('hi')]]);
      const id = await newSession(b);
      const image = await upload(b, id, 'image/png');
      await send(b, id, 'look', { attachmentIds: [image] });
      const created = await share(b, id, {
        subjectRef: 'user:default/bob',
      }).expect(201);
      const shareId = created.body.id;
      await as('bob', request(b.app).get(`/sessions/${id}`)).expect(200);
      await as(
        'bob',
        request(b.app).get(`/sessions/${id}/attachments/${image}`),
      ).expect(200);

      await as(
        'jane',
        request(b.app).delete(`/sessions/${id}/shares/${shareId}`),
      ).expect(204);
      await as('bob', request(b.app).get(`/sessions/${id}`)).expect(404);
      await as(
        'bob',
        request(b.app).get(`/sessions/${id}/attachments/${image}`),
      ).expect(404);
      await as('bob', request(b.app).get(`/sessions/${id}/stream`)).expect(404);
      for (const res of [
        await as(
          'jane',
          request(b.app).patch(`/sessions/${id}/shares/${shareId}`),
        ).send({ refresh: true }),
        await as(
          'jane',
          request(b.app).delete(`/sessions/${id}/shares/${shareId}`),
        ),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.error.name).toBe('ShareNotFound');
      }
    });
  });

  describe('the sharee cannot act (SH-03)', () => {
    it('answers every change of a sharee like a session that does not exist, and changes nothing', async () => {
      const b = await start([write(), [say('never')]]);
      const id = await newSession(b);
      await send(b, id, 'change it');
      const owner = await as(
        'jane',
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      const run = owner.body.run;
      const [callId] = owner.body.awaitingDecision;
      expect(run.status).toBe('waiting_approval');
      const created = await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
        includeLaterToolOutputs: true,
      }).expect(201);
      const image = await upload(b, id, 'image/png');
      const runCount = await world.runCount();
      const before = await items(b, id, 'jane');

      const sharee = await as(
        'bob',
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(sharee.body.run).toMatchObject({ id: run.id });
      expect(sharee.body.awaitingDecision).toEqual([]);
      expect(sharee.body.resumable).toBe(false);

      const attempts: [string, request.Test][] = [
        [
          'send',
          request(b.app).post(`/sessions/${id}/runs`).send({ text: 'x' }),
        ],
        [
          'approve',
          request(b.app)
            .post(`/sessions/${id}/tool-calls/${callId}/decision`)
            .send({ approved: true }),
        ],
        [
          'deny',
          request(b.app)
            .post(`/sessions/${id}/tool-calls/${callId}/decision`)
            .send({ approved: false }),
        ],
        ['resume', request(b.app).post(`/sessions/${id}/resume`).send({})],
        [
          'cancel',
          request(b.app).post(`/sessions/${id}/runs/${run.id}/cancel`),
        ],
        [
          'insert',
          request(b.app)
            .post(`/sessions/${id}/runs/${run.id}/messages`)
            .send({ text: 'x' }),
        ],
        [
          'queue',
          request(b.app).post(`/sessions/${id}/queue`).send({ text: 'x' }),
        ],
        ['list queue', request(b.app).get(`/sessions/${id}/queue`)],
        ['resume queue', request(b.app).post(`/sessions/${id}/queue/resume`)],
        [
          'upload',
          request(b.app)
            .post(`/sessions/${id}/attachments`)
            .query({ name: 'a' })
            .set('Content-Type', 'image/png')
            .send(IMAGES['image/png']),
        ],
        [
          'rename',
          request(b.app).patch(`/sessions/${id}`).send({ title: 'x' }),
        ],
        ['delete', request(b.app).delete(`/sessions/${id}`)],
        ['tools', request(b.app).get(`/sessions/${id}/tools`)],
        ['list shares', request(b.app).get(`/sessions/${id}/shares`)],
        [
          'share',
          request(b.app)
            .post(`/sessions/${id}/shares`)
            .send({ subjectRef: 'user:default/cara' }),
        ],
        [
          'change share',
          request(b.app)
            .patch(`/sessions/${id}/shares/${created.body.id}`)
            .send({ includeToolOutputs: false }),
        ],
        [
          'cancel share',
          request(b.app).delete(`/sessions/${id}/shares/${created.body.id}`),
        ],
      ];
      for (const [name, attempt] of attempts) {
        const res = await as('bob', attempt);
        expect({ name, status: res.status }).toEqual({ name, status: 404 });
      }

      expect(await world.runCount()).toBe(runCount);
      expect(await items(b, id, 'jane')).toEqual(before);
      expect(world.actions.count('demo:write')).toBe(0);
      expect(world.audit.ids()).not.toContain('tool-call-approve');
      expect(world.audit.ids()).not.toContain('tool-call-deny');
      const after = await as(
        'jane',
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(after.body.session).toEqual(owner.body.session);
      expect(after.body.run).toMatchObject({ status: 'waiting_approval' });
      expect(after.body.awaitingDecision).toEqual([callId]);
      await as(
        'jane',
        request(b.app).get(`/sessions/${id}/attachments/${image}`),
      ).expect(200);
      const shares = await as(
        'jane',
        request(b.app).get(`/sessions/${id}/shares`),
      ).expect(200);
      expect(shares.body.items).toEqual([created.body]);
      expect(shareEvents().map(event => event.eventId)).toEqual([
        'session-share',
      ]);
    });
  });

  describe('expiry (SH-11)', () => {
    it('freezes a live share at its expiry, and a new life lets it go on', async () => {
      const b = await start([[say('one')], [say('two')], [say('three')]]);
      const id = await newSession(b);
      const created = await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
      }).expect(201);
      expect(created.body.expiresAt).toBe('2026-01-02T00:00:00.000Z');
      await send(b, id, 'first');
      const first = await items(b, id);
      expect(first.map(item => item.text)).toContain('one');

      world.clock.advance(24 * HOUR + 1);
      await send(b, id, 'second');
      expect(await items(b, id)).toEqual(first);
      expect(await items(b, id, 'bob', { afterSeq: 0 })).toEqual(first);
      const listed = await as(
        'jane',
        request(b.app).get(`/sessions/${id}/shares`),
      ).expect(200);
      expect(listed.body.items[0].expired).toBe(true);
      await as('bob', request(b.app).get(`/sessions/${id}/stream`)).expect(204);

      const renewed = await as(
        'jane',
        request(b.app).patch(`/sessions/${id}/shares/${created.body.id}`),
      )
        .send({ hours: 72 })
        .expect(200);
      expect(renewed.body).toMatchObject({
        expired: false,
        expiresAt: '2026-01-05T00:00:01.000Z',
      });
      expect(await items(b, id)).toEqual(await items(b, id, 'jane'));
      await as(
        'jane',
        request(b.app).patch(`/sessions/${id}/shares/${created.body.id}`),
      )
        .send({ hours: 73 })
        .expect(400);
    });

    it('takes the default and the maximum life from the configuration, and refuses live shares when they are off', async () => {
      const b = await start([], {
        liveShares: { enabled: true, defaultHours: 2, maxHours: 4 },
      });
      const id = await newSession(b);
      const made = await share(b, id, {
        subjectRef: 'user:bob',
        mode: 'live',
      }).expect(201);
      expect(made.body.expiresAt).toBe('2026-01-01T02:00:00.000Z');
      await share(b, id, {
        subjectRef: 'user:bob',
        mode: 'live',
        hours: 5,
      }).expect(400);
      await world.cleanup();

      const off = await start([], {
        liveShares: { enabled: false, defaultHours: 24, maxHours: 72 },
      });
      const other = await newSession(off);
      const refused = await share(off, other, {
        subjectRef: 'user:bob',
        mode: 'live',
      }).expect(400);
      expect(refused.body.error.name).toBe('LiveSharingDisabled');
      await share(off, other, { subjectRef: 'user:bob' }).expect(201);
    });
  });

  describe('images (IN-19)', () => {
    it('lets the sharee read the images of the messages the share shows, and no other', async () => {
      const b = await start([[say('one')], [say('two')], write(), [say('x')]]);
      const id = await newSession(b);
      const seen = await upload(b, id, 'image/png');
      await send(b, id, 'first', { attachmentIds: [seen] });
      await share(b, id, { subjectRef: 'user:default/bob' }).expect(201);
      const later = await upload(b, id, 'image/gif');
      await send(b, id, 'second', { attachmentIds: [later] });
      const loose = await upload(b, id, 'image/webp');

      const owner = await as(
        'jane',
        request(b.app).get(`/sessions/${id}/attachments/${seen}`),
      ).expect(200);
      const bob = await as(
        'bob',
        request(b.app).get(`/sessions/${id}/attachments/${seen}`),
      ).expect(200);
      expect(Buffer.compare(bob.body, IMAGES['image/png'])).toBe(0);
      expect(bob.headers.etag).toBe(owner.headers.etag);
      await as(
        'bob',
        request(b.app)
          .get(`/sessions/${id}/attachments/${seen}`)
          .set('If-None-Match', owner.headers.etag),
      ).expect(304);
      for (const hidden of [later, loose, 'missing']) {
        const res = await as(
          'bob',
          request(b.app).get(`/sessions/${id}/attachments/${hidden}`),
        ).expect(404);
        expect(res.body.error.name).toBe('AttachmentNotFound');
      }
      // A cached tag does not turn a hidden image into 304.
      await as(
        'bob',
        request(b.app)
          .get(`/sessions/${id}/attachments/${later}`)
          .set('If-None-Match', '*'),
      ).expect(404);

      // A live share shows every image already in a message, not one that
      // waits in the queue.
      await share(b, id, {
        subjectRef: 'user:default/cara',
        mode: 'live',
      }).expect(201);
      await send(b, id, 'change');
      const queued = await upload(b, id, 'image/jpeg');
      await as('jane', request(b.app).post(`/sessions/${id}/queue`))
        .send({ text: 'next', attachmentIds: [queued] })
        .expect(201);
      for (const visible of [seen, later]) {
        await as(
          'cara',
          request(b.app).get(`/sessions/${id}/attachments/${visible}`),
        ).expect(200);
      }
      for (const hidden of [loose, queued]) {
        await as(
          'cara',
          request(b.app).get(`/sessions/${id}/attachments/${hidden}`),
        ).expect(404);
      }
    });

    it('stops at the expiry of a live share', async () => {
      const b = await start([[say('one')], [say('two')]]);
      const id = await newSession(b);
      await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
      }).expect(201);
      const before = await upload(b, id, 'image/png');
      await send(b, id, 'first', { attachmentIds: [before] });
      world.clock.advance(25 * HOUR);
      const after = await upload(b, id, 'image/gif');
      await send(b, id, 'second', { attachmentIds: [after] });
      const statusOf = async (image: string) =>
        (
          await as(
            'bob',
            request(b.app).get(`/sessions/${id}/attachments/${image}`),
          )
        ).status;
      expect(await statusOf(before)).toBe(200);
      expect(await statusOf(after)).toBe(404);
    });
  });

  describe('following the run (section 5, SH-09)', () => {
    /**
     * A model whose second call waits for `release`. A title call is
     * answered at once and is not a step.
     */
    function gatedModel(steps: ModelChunk[][]) {
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      let calls = 0;
      const model: ModelClient = {
        capabilities: { parallelToolCalls: false, images: false },
        async *stream(input) {
          if (input.system.startsWith(TITLE_PROMPT_MARK)) {
            yield say('Title');
            return;
          }
          const step = steps[calls];
          calls += 1;
          if (calls === 2) await gate;
          yield* step;
        },
      };
      return { model, release: () => release() };
    }

    it('sends a live sharee only what the share shows, and no call to approve', async () => {
      const gated = gatedModel([read('secret'), write()]);
      const b = await start([], {}, { model: gated.model });
      const id = await newSession(b);
      await share(b, id, {
        subjectRef: 'user:default/bob',
        mode: 'live',
      }).expect(201);
      const handle = await b.useCases.sendMessage.execute({
        principal: principalOf('jane'),
        sessionId: id,
        text: 'go',
      });
      const draining = (async () => {
        for await (const _event of handle.events) {
          // The owner's stream is read to its end.
        }
      })();
      await until(async () =>
        (await world.items.read(id)).some(item => item.kind === 'tool_result'),
      );

      const server = createServer(b.app);
      servers.push(server);
      await new Promise<void>(resolve =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/sessions/${id}/stream`,
        { headers: { 'x-user': 'bob' } },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      gated.release();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      await draining;

      const chunks = await parseSse(text);
      const types = chunks.map(chunk => chunk.type);
      expect(types[0]).toBe('start');
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'tool-output-available',
          output: 'not shared',
        }),
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'tool-input-available',
          toolName: 'demo:write',
        }),
      );
      expect(types).not.toContain('tool-approval-request');
      expect(types).not.toContain('text-delta');
      expect(types[types.length - 1]).toBe('finish');
      expect(text).not.toContain('things');
      const owner = await as(
        'jane',
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(owner.body.run.status).toBe('waiting_approval');
    });
  });
});

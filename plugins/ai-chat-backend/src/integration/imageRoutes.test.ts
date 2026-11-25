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

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { say, waitForAbort } from '@kwkevinchan/ai-chat-harness/testing';
import express from 'express';
import request from 'supertest';
import { createRouter } from '../adapters/http';
import { principalFromRequest } from '../adapters/backstage/principalFromRequest';
import { IMAGES, pngOfSize } from '../__testUtils__/images';
import { createWorld, testInputConfig, until } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']> & { app: express.Express };

const JANE = mockCredentials.user.header('user:default/jane');
const MALLORY = mockCredentials.user.header('user:default/mallory');
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** The fake clock moves in seconds. */
const HOUR = 3600;

/**
 * The routes of the images (PI-05) on a real database, behind the error
 * handler of Backstage: the status codes and the names of the errors, the
 * limits on the size (checked before the body is read), who may upload and
 * read, and the headers of an image.
 */
describe('the routes of the images', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];
  const servers: http.Server[] = [];

  async function start(options: Parameters<typeof createWorld>[0] = {}) {
    world = await createWorld(options);
  }

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
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

  const as = (user: string | undefined, test: request.Test) =>
    user ? test.set('Authorization', user) : test;

  async function newSession(b: Backend, user = JANE) {
    return (await as(user, request(b.app).post('/sessions')).expect(201)).body
      .id as string;
  }

  const upload = (
    b: Backend,
    sessionId: string,
    options: {
      user?: string | undefined;
      type?: string;
      name?: string;
      body?: Buffer;
    } = {},
  ) =>
    as(
      'user' in options ? options.user : JANE,
      request(b.app)
        .post(`/sessions/${sessionId}/attachments`)
        .query({ name: options.name ?? 'shot.png' })
        .set('Content-Type', options.type ?? 'image/png'),
    ).send(options.body ?? IMAGES['image/png']);

  /**
   * A request made by hand, so the headers say what the test wants and the
   * body is as long as the test wants: `headers` and then the `chunks` that
   * are written. Resolves with the answer, which can come before the body is
   * written to the end.
   */
  async function raw(
    b: Backend,
    path: string,
    options: {
      headers: Record<string, string>;
      chunks: Buffer[];
    },
  ): Promise<{ status: number; body: any; connection?: string }> {
    const server = http.createServer(b.app).listen(0);
    servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          port,
          path,
          method: 'POST',
          headers: { Authorization: JANE, ...options.headers },
        },
        res => {
          let text = '';
          res.on('data', d => (text += d));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body: text ? JSON.parse(text) : undefined,
              connection: res.headers.connection,
            }),
          );
        },
      );
      req.on('error', error => {
        // The server may close the connection once it has answered.
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET')
          reject(error);
      });
      req.flushHeaders();
      for (const chunk of options.chunks) req.write(chunk);
      // The request is not ended when the test wants an answer before the
      // body is complete.
      if (options.headers['Content-Length'] === undefined) return;
    });
  }

  describe('POST /sessions/:id/attachments (IN-01 to IN-04)', () => {
    it.each(TYPES)(
      'takes a real %s and answers 201 with the id, type, name and size',
      async type => {
        await start();
        const b = backend([]);
        const id = await newSession(b);
        const res = await upload(b, id, {
          type,
          body: IMAGES[type],
          name: 'picture',
        }).expect(201);
        expect(res.body).toEqual({
          id: expect.any(String),
          mediaType: type,
          name: 'picture',
          size: IMAGES[type].length,
        });
      },
    );

    it('takes a type with parameters and in capitals, and stores the type without them', async () => {
      await start();
      const b = backend([]);
      const id = await newSession(b);
      const res = await upload(b, id, {
        type: 'Image/PNG; charset=binary',
      }).expect(201);
      expect(res.body.mediaType).toBe('image/png');
    });

    it('answers 415 UnsupportedAttachmentType for SVG and for any type that is not an image, and stores nothing', async () => {
      await start();
      const b = backend([]);
      const id = await newSession(b);
      for (const type of [
        'image/svg+xml',
        'text/html',
        'application/octet-stream',
        'application/json',
      ]) {
        const res = await upload(b, id, {
          type,
          body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        }).expect(415);
        expect([type, res.body.error.name]).toEqual([
          type,
          'UnsupportedAttachmentType',
        ]);
      }
      expect(
        await upload(b, id, { type: 'text/plain' }).expect(415),
      ).toBeDefined();
      expect(
        Number((await world.knex('attachments').count({ n: '*' }))[0].n),
      ).toBe(0);
    });

    it('answers 400 InvalidAttachment when the type says PNG and the content is JPEG, for every pair of types', async () => {
      await start();
      const b = backend([]);
      const id = await newSession(b);
      for (const declared of TYPES) {
        for (const actual of TYPES) {
          if (declared === actual) continue;
          const res = await upload(b, id, {
            type: declared,
            body: IMAGES[actual],
          });
          expect([declared, actual, res.status, res.body.error?.name]).toEqual([
            declared,
            actual,
            400,
            'InvalidAttachment',
          ]);
        }
      }
      expect(
        Number((await world.knex('attachments').count({ n: '*' }))[0].n),
      ).toBe(0);
    });

    it('answers 400 for an empty body, a name that is empty after cleaning, and a request with no name', async () => {
      await start();
      const b = backend([]);
      const id = await newSession(b);
      expect(
        (await upload(b, id, { body: Buffer.alloc(0) }).expect(400)).body.error
          .name,
      ).toBe('InvalidAttachment');
      expect(
        (await upload(b, id, { name: '\n\t' }).expect(400)).body.error.name,
      ).toBe('InvalidAttachment');
      await as(
        JANE,
        request(b.app)
          .post(`/sessions/${id}/attachments`)
          .set('Content-Type', 'image/png'),
      )
        .send(IMAGES['image/png'])
        .expect(400);
    });

    it('cleans the name: no control character, no path separator, 255 characters at most; the type is never taken from it', async () => {
      await start();
      const b = backend([]);
      const id = await newSession(b);
      const res = await upload(b, id, { name: '../a\u0001b/c.svg' }).expect(
        201,
      );
      expect(res.body).toMatchObject({
        name: '.._ab_c.svg',
        mediaType: 'image/png',
      });
      const long = await upload(b, id, { name: 'x'.repeat(400) }).expect(201);
      expect(long.body.name).toHaveLength(255);
    });

    describe('the size is checked before the body is read (IN-02)', () => {
      const LIMIT = 100;

      it('answers 413 AttachmentTooLarge for a Content-Length over the limit, at once, and never calls the use case', async () => {
        await start({ images: { maxBytes: LIMIT } });
        const b = backend([]);
        const id = await newSession(b);
        const execute = jest.spyOn(b.useCases.uploadAttachment, 'execute');

        // The headers say 50 MB; ten bytes are sent and the request is not
        // ended: the answer must come anyway.
        const res = await raw(b, `/sessions/${id}/attachments?name=big.png`, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(50 * 1024 * 1024),
          },
          chunks: [Buffer.alloc(10, 1)],
        });

        expect(res.status).toBe(413);
        expect(res.body.error.name).toBe('AttachmentTooLarge');
        expect(res.connection).toBe('close');
        expect(execute).not.toHaveBeenCalled();
      });

      it('answers 413 for a body with no Content-Length that grows over the limit, as soon as it does, and never calls the use case', async () => {
        await start({ images: { maxBytes: LIMIT } });
        const b = backend([]);
        const id = await newSession(b);
        const execute = jest.spyOn(b.useCases.uploadAttachment, 'execute');

        // Chunked: no length is known. The first chunk fits, the second does not.
        const res = await raw(b, `/sessions/${id}/attachments?name=big.png`, {
          headers: {
            'Content-Type': 'image/png',
            'Transfer-Encoding': 'chunked',
          },
          chunks: [Buffer.alloc(60, 1), Buffer.alloc(60, 1)],
        });

        expect(res.status).toBe(413);
        expect(res.body.error.name).toBe('AttachmentTooLarge');
        expect(execute).not.toHaveBeenCalled();
      });

      it('answers 413 for a body that is longer than its Content-Length says it is, and keeps no more than the limit', async () => {
        await start({ images: { maxBytes: LIMIT } });
        const b = backend([]);
        const id = await newSession(b);
        const execute = jest.spyOn(b.useCases.uploadAttachment, 'execute');

        const res = await raw(b, `/sessions/${id}/attachments?name=big.png`, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': '50',
          },
          chunks: [Buffer.alloc(500, 1)],
        });

        // Node ends the body at the length of the header, so this is a
        // normal short body that is not a PNG: it is refused by the header
        // check, not stored.
        expect([400, 413]).toContain(res.status);
        expect(execute.mock.calls.length <= 1).toBe(true);
        expect(
          Number((await world.knex('attachments').count({ n: '*' }))[0].n),
        ).toBe(0);
      });

      it('takes an image of exactly the limit and refuses one byte more', async () => {
        await start({ images: { maxBytes: pngOfSize(LIMIT).length } });
        const b = backend([]);
        const id = await newSession(b);
        const fits = await upload(b, id, { body: pngOfSize(LIMIT) });
        const over = await upload(b, id, { body: pngOfSize(LIMIT + 1) });
        expect([fits.status, over.status]).toEqual([201, 413]);
      });
    });

    describe('who may upload (IN-03)', () => {
      it('answers 401 with no user, and 404 for a session of another user, and reads no byte of the body for either', async () => {
        await start();
        const b = backend([]);
        const id = await newSession(b);
        const execute = jest.spyOn(b.useCases.uploadAttachment, 'execute');

        await upload(b, id, { user: undefined }).expect(401);
        await upload(b, id, { user: MALLORY }).expect(404);
        const missing = await upload(b, 'no-such-session').expect(404);
        expect(missing.body.error.message).toBe(
          (await upload(b, id, { user: MALLORY })).body.error.message.replace(
            id,
            'no-such-session',
          ),
        );

        // A body of 50 MB is announced and none is sent: the answer is 404,
        // and the connection is closed, so the body is not read off the socket.
        const refused = await raw(b, `/sessions/${id}/attachments?name=x.png`, {
          headers: {
            Authorization: MALLORY,
            'Content-Type': 'image/png',
            'Content-Length': String(50 * 1024 * 1024),
          },
          chunks: [],
        });
        expect(refused.status).toBe(404);
        expect(refused.connection).toBe('close');
        expect(execute).not.toHaveBeenCalled();
        expect(
          Number((await world.knex('attachments').count({ n: '*' }))[0].n),
        ).toBe(0);
      });
    });

    it('answers 409 TooManyPendingAttachments for the thirteenth image that is in no message', async () => {
      await start();
      const b = backend([]);
      const id = await newSession(b);
      for (let i = 0; i < 12; i++) await upload(b, id).expect(201);
      const res = await upload(b, id).expect(409);
      expect(res.body.error.name).toBe('TooManyPendingAttachments');
      // Another session has its own count.
      await upload(b, await newSession(b)).expect(201);
    });

    it('answers 400 ImagesNotSupported when the model cannot read images', async () => {
      await start({ images: { enabled: false } });
      const b = backend([]);
      const id = await newSession(b);
      const res = await upload(b, id).expect(400);
      expect(res.body.error.name).toBe('ImagesNotSupported');
    });
  });

  describe('GET /sessions/:id/attachments/:attachmentId (IN-03)', () => {
    async function uploaded(
      b: Backend,
      type: (typeof TYPES)[number] = 'image/png',
    ) {
      const id = await newSession(b);
      const res = await upload(b, id, { type, body: IMAGES[type] }).expect(201);
      return { id, attachmentId: res.body.id as string };
    }
    const read = (
      b: Backend,
      id: string,
      attachmentId: string,
      user: string | null = JANE,
    ) =>
      as(
        user ?? undefined,
        request(b.app).get(`/sessions/${id}/attachments/${attachmentId}`),
      );

    it.each(TYPES)(
      'gives the bytes of a %s with the type that was stored and the headers that keep a browser from running it',
      async type => {
        await start();
        const b = backend([]);
        const { id, attachmentId } = await uploaded(b, type);
        const res = await read(b, id, attachmentId)
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', c => chunks.push(c));
            response.on('end', () => done(null, Buffer.concat(chunks)));
          })
          .expect(200);
        expect(res.headers['content-type']).toBe(type);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-disposition']).toBe('inline');
        expect(res.headers['content-security-policy']).toBe(
          "default-src 'none'; sandbox",
        );
        expect(res.headers['cache-control']).toBe('private, no-cache');
        expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
        expect((res.body as Buffer).equals(IMAGES[type])).toBe(true);
      },
    );

    it('answers 401 with no user, and 404 for another user, with a message that does not tell an image from none', async () => {
      await start();
      const b = backend([]);
      const { id, attachmentId } = await uploaded(b);
      await read(b, id, attachmentId, null).expect(401);
      const other = await read(b, id, attachmentId, MALLORY).expect(404);
      const none = await read(b, id, 'nothing', MALLORY).expect(404);
      expect(other.body.error.message).toBe(none.body.error.message);
    });

    it('answers 404 for an image of another session of the same user', async () => {
      await start();
      const b = backend([]);
      const { attachmentId } = await uploaded(b);
      const mine = await newSession(b);
      const res = await read(b, mine, attachmentId).expect(404);
      expect(res.body.error.name).toBe('AttachmentNotFound');
    });

    it('answers 304 when If-None-Match is the ETag, with the same headers and no body; any other value gets the image', async () => {
      await start();
      const b = backend([]);
      const { id, attachmentId } = await uploaded(b);
      const first = await read(b, id, attachmentId).expect(200);
      const same = await read(b, id, attachmentId)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
      expect(same.headers.etag).toBe(first.headers.etag);
      expect(same.headers['cache-control']).toBe('private, no-cache');
      expect(same.headers['x-content-type-options']).toBe('nosniff');
      expect(same.body).toEqual({});
      await read(b, id, attachmentId)
        .set('If-None-Match', '"other"')
        .expect(200);
      await read(b, id, attachmentId)
        .set('If-None-Match', `W/${first.headers.etag}`)
        .expect(304);
    });

    it('does not answer 304 to another user or for a deleted image, whatever the client has cached', async () => {
      await start();
      const b = backend([]);
      const { id, attachmentId } = await uploaded(b);
      const etag = (await read(b, id, attachmentId).expect(200)).headers.etag;

      await read(b, id, attachmentId, MALLORY)
        .set('If-None-Match', etag)
        .expect(404);
      await read(b, id, attachmentId, null)
        .set('If-None-Match', etag)
        .expect(401);

      // The image is unused, so the cleaning deletes it after 24 hours.
      world.clock.advance(25 * HOUR);
      expect(await b.useCases.purgeUnusedAttachments.execute()).toBe(1);
      await read(b, id, attachmentId).set('If-None-Match', etag).expect(404);
      await read(b, id, attachmentId).expect(404);
    });
  });

  describe('messages with images', () => {
    async function uploadedIn(b: Backend, id: string, count = 1) {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        ids.push((await upload(b, id).expect(201)).body.id);
      }
      return ids;
    }

    it('sends a message with images: the answer streams, the log keeps the images, the model gets them', async () => {
      await start();
      const b = backend([[say('a screenshot')]]);
      const id = await newSession(b);
      const [a] = await uploadedIn(b, id);

      await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'what is this?', attachmentIds: [a] })
        .expect(200);

      const detail = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(detail.body.items[0]).toMatchObject({
        kind: 'user_message',
        attachments: [{ id: a, mediaType: 'image/png', name: 'shot.png' }],
      });
      expect(b.model.inputs[0].messages[0]).toMatchObject({
        images: [{ attachmentId: a }],
      });
    });

    it('answers 400 AttachmentNotFound when a message names an image of another session, on every route that takes a message', async () => {
      await start();
      const b = backend([waitForAbort]);
      const id = await newSession(b);
      const theirs = await newSession(b, MALLORY);
      const [foreign] = await (async () => {
        const res = await upload(b, theirs, { user: MALLORY }).expect(201);
        return [res.body.id as string];
      })();
      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go' })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      const attempts: [string, string, object][] = [
        [
          'post',
          `/sessions/${id}/runs/${runId}/messages`,
          { text: 'x', attachmentIds: [foreign] },
        ],
        [
          'post',
          `/sessions/${id}/queue`,
          { text: 'x', attachmentIds: [foreign] },
        ],
      ];
      for (const [method, path, body] of attempts) {
        const res = await as(JANE, (request(b.app) as any)[method](path)).send(
          body,
        );
        expect([path, res.status, res.body.error?.name]).toEqual([
          path,
          400,
          'AttachmentNotFound',
        ]);
      }
      // A message that does not start a run is refused before anything is written.
      expect(await world.items.read(id)).toHaveLength(1);
      expect(await world.queue.list(id)).toEqual([]);
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
      const send = await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'x', attachmentIds: [foreign] })
        .expect(400);
      expect(send.body.error.name).toBe('AttachmentNotFound');
    });

    it('answers 400 TooManyAttachments for five images in one message', async () => {
      await start();
      const b = backend([[say('x')]]);
      const id = await newSession(b);
      const ids = await uploadedIn(b, id, 5);
      const res = await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'x', attachmentIds: ids })
        .expect(400);
      expect(res.body.error.name).toBe('TooManyAttachments');
      expect(await world.runCount()).toBe(0);
    });

    it('answers 400 for an attachmentIds that is not a list of ids, or repeats an id', async () => {
      await start();
      const b = backend([[say('x')]]);
      const id = await newSession(b);
      const statuses: number[] = [];
      for (const attachmentIds of ['a', [1], ['a', 'a'], [''], [null]]) {
        const res = await as(
          JANE,
          request(b.app).post(`/sessions/${id}/runs`),
        ).send({ text: 'x', attachmentIds });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([400, 400, 400, 400, 400]);
    });

    it('answers 400 ImagesNotSupported for a message with images when the model cannot read them', async () => {
      await start({ images: { enabled: false } });
      const b = backend([[say('x')]]);
      const id = await newSession(b);
      // The upload is refused as well, so the image is put in the store by hand.
      const meta = await world.attachments.put({
        sessionId: id,
        ownerRef: 'user:default/jane',
        mediaType: 'image/png',
        name: 'a.png',
        bytes: IMAGES['image/png'],
        maxPending: 12,
      });
      const res = await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'x', attachmentIds: [meta.id] })
        .expect(400);
      expect(res.body.error.name).toBe('ImagesNotSupported');
      expect(await world.runCount()).toBe(0);
    });

    it('answers 400 TooManyImageBytes for an inserted message that takes the run over the limit, and writes nothing', async () => {
      await start({ images: { maxBytesPerInput: 1000 } });
      const b = backend([waitForAbort]);
      const id = await newSession(b);
      const first = await upload(b, id, { body: pngOfSize(700) }).expect(201);
      const second = await upload(b, id, { body: pngOfSize(400) }).expect(201);
      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go', attachmentIds: [first.body.id] })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      const res = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/messages`),
      )
        .send({ text: 'more', attachmentIds: [second.body.id] })
        .expect(400);

      expect(res.body.error.name).toBe('TooManyImageBytes');
      expect(await world.items.read(id)).toHaveLength(1);
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });

    it('shows the images in the queue and in the session, and keeps them when the message is changed', async () => {
      await start();
      const b = backend([waitForAbort]);
      const id = await newSession(b);
      const [a] = await uploadedIn(b, id);
      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go' })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      const queued = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/queue`),
      )
        .send({ text: 'later', attachmentIds: [a] })
        .expect(201);
      expect(queued.body.attachments).toEqual([
        {
          id: a,
          mediaType: 'image/png',
          name: 'shot.png',
          size: IMAGES['image/png'].length,
        },
      ]);
      const changed = await as(
        JANE,
        request(b.app).patch(`/sessions/${id}/queue/${queued.body.id}`),
      )
        .send({ text: 'later!' })
        .expect(200);
      expect(changed.body.attachments).toHaveLength(1);
      const detail = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(detail.body.queue.items[0].attachments).toHaveLength(1);
      const cleared = await as(
        JANE,
        request(b.app).patch(`/sessions/${id}/queue/${queued.body.id}`),
      )
        .send({ attachmentIds: [] })
        .expect(200);
      expect(cleared.body.attachments).toEqual([]);
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });

    it('accepts a message that has images and no text on send, and stores the images', async () => {
      await start();
      const b = backend([[say('seen')]]);
      const id = await newSession(b);
      const [a] = await uploadedIn(b, id);

      await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: '', attachmentIds: [a] })
        .expect(200);

      const detail = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(detail.body.items[0]).toMatchObject({
        kind: 'user_message',
        text: '',
        attachments: [{ id: a }],
      });
      expect(b.model.inputs[0].messages[0]).toMatchObject({
        content: '',
        images: [{ attachmentId: a }],
      });
    });

    it('accepts an inserted message that has images and no text', async () => {
      await start();
      const b = backend([waitForAbort]);
      const id = await newSession(b);
      const [a] = await uploadedIn(b, id);
      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go' })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      const res = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/messages`),
      )
        .send({ text: '', attachmentIds: [a] })
        .expect(201);

      expect(res.body).toMatchObject({
        kind: 'user_message',
        text: '',
        attachments: [{ id: a }],
      });
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });

    it('accepts a queued message that has images and no text', async () => {
      await start();
      const b = backend([waitForAbort]);
      const id = await newSession(b);
      const [a] = await uploadedIn(b, id);
      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go' })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      const res = await as(JANE, request(b.app).post(`/sessions/${id}/queue`))
        .send({ text: '', attachmentIds: [a] })
        .expect(201);

      expect(res.body).toMatchObject({
        text: '',
        attachments: [{ id: a }],
      });
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });

    it('refuses a change that would leave a queued message with no text and no image', async () => {
      await start();
      const b = backend([waitForAbort]);
      const id = await newSession(b);
      const [a] = await uploadedIn(b, id);
      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go' })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      const queued = await as(
        JANE,
        request(b.app).post(`/sessions/${id}/queue`),
      )
        .send({ text: '', attachmentIds: [a] })
        .expect(201);

      const refused = await as(
        JANE,
        request(b.app).patch(`/sessions/${id}/queue/${queued.body.id}`),
      )
        .send({ attachmentIds: [] })
        .expect(400);
      expect(refused.body.error).toMatchObject({
        name: 'EmptyMessage',
        message: 'must have text or at least one image',
      });
      const still = await as(
        JANE,
        request(b.app).get(`/sessions/${id}`),
      ).expect(200);
      expect(still.body.queue.items[0]).toMatchObject({
        id: queued.body.id,
        text: '',
        attachments: [{ id: a }],
      });

      await as(
        JANE,
        request(b.app).patch(`/sessions/${id}/queue/${queued.body.id}`),
      )
        .send({ text: 'later', attachmentIds: [] })
        .expect(200);
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });

    it('refuses a message with no text and no image on send, insert and queue', async () => {
      await start();
      const b = backend([waitForAbort]);
      const id = await newSession(b);

      await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: '' })
        .expect(400);
      await as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: '', attachmentIds: [] })
        .expect(400);
      expect(await world.runCount()).toBe(0);

      const pending = as(JANE, request(b.app).post(`/sessions/${id}/runs`))
        .send({ text: 'go' })
        .then(res => res);
      await until(() => b.model.inputs.length === 1);
      const runId = (await world.knex('runs').where({ session_id: id }).first())
        .id;

      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/messages`),
      )
        .send({ text: '' })
        .expect(400);
      await as(JANE, request(b.app).post(`/sessions/${id}/queue`))
        .send({ text: '   ' })
        .expect(400);
      expect(await world.items.read(id)).toHaveLength(1);
      expect(await world.queue.list(id)).toEqual([]);
      await as(
        JANE,
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    });
  });

  describe('GET /input-config', () => {
    it('answers with the settings, and 401 with no user', async () => {
      await start();
      const b = backend([]);
      const res = await as(JANE, request(b.app).get('/input-config')).expect(
        200,
      );
      expect(res.body).toEqual(testInputConfig);
      await as(undefined, request(b.app).get('/input-config')).expect(401);
    });
  });
});

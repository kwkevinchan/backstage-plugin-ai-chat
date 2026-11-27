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
import request from 'supertest';
import { createRouter } from '../adapters/http';
import { inputConfigOf } from '../adapters/http/controllers/attachments';
import type { Principal } from '../domain';
import {
  createWorld,
  FakeEntityReader,
  testInputConfig,
  until,
} from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']> & { app: express.Express };

const SHOP = { kind: 'entity', entityRef: 'Component:shop' };
const SECRET = { kind: 'entity', entityRef: 'component:default/secret' };
const SNIPPET = {
  kind: 'text',
  text: 'Restart the pods one at a time.',
  title: 'Runbook',
  url: 'https://example.com/runbook',
};
const STORED_SHOP = {
  kind: 'entity',
  entityRef: 'component:default/shop',
  readable: true,
  entity: {
    kind: 'component',
    namespace: 'default',
    name: 'shop',
    title: 'Shop',
    owner: 'group:default/team-a',
  },
};
const STORED_SECRET = {
  kind: 'entity',
  entityRef: 'component:default/secret',
  readable: false,
};

const userTexts = (input: { messages: { role: string; content: unknown }[] }) =>
  input.messages.filter(m => m.role === 'user').map(m => m.content as string);

/**
 * The references of a message (B-04) through the routes, on a real database
 * and a fake catalog: the checks of the request, the entities read as the
 * user and kept on the message, the model input, the inserted and the queued
 * messages, and the view of a sharee.
 */
describe('the references of a message', () => {
  let world: World;
  let entities: FakeEntityReader;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  async function start(
    script: Parameters<World['backend']>[0],
    options: Parameters<typeof createWorld>[0] = {},
  ): Promise<Backend> {
    entities = new FakeEntityReader([
      {
        ref: 'component:default/shop',
        facts: { title: 'Shop', owner: 'group:default/team-a' },
      },
      {
        ref: 'component:default/secret',
        facts: { description: 'Only for the security team.' },
        readers: ['user:default/mallory'],
      },
    ]);
    world = await createWorld({ entities, ...options });
    const b = world.backend(script);
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

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world?.cleanup();
  });

  /** Credentials that last a day after the start of the fake clock, so the queue sends by itself (IN-16). */
  function principalOf(name: string): Principal {
    const userRef = `user:default/${name}`;
    return {
      userRef,
      ownershipRefs: [userRef],
      credentials: mockCredentials.user(userRef),
      credentialsExpireAt: '2026-01-02T00:00:00.000Z',
    };
  }

  const as = (user: string, test: request.Test) => test.set('x-user', user);

  async function newSession(b: Backend) {
    return (await as('jane', request(b.app).post('/sessions')).expect(201)).body
      .id as string;
  }

  const send = (b: Backend, id: string, body: object) =>
    as('jane', request(b.app).post(`/sessions/${id}/runs`)).send({
      text: 'what now?',
      ...body,
    });

  const userMessages = async (id: string) =>
    (await world.items.read(id)).filter(item => item.kind === 'user_message');

  /** A session with a run whose model call does not end until it is stopped. */
  async function blocked(b: Backend) {
    const id = await newSession(b);
    const pending = send(b, id, { text: 'go' }).then(res => res);
    await until(() => b.model.inputs.length === 1);
    const runId = (await world.knex('runs').where({ session_id: id }).first())
      .id as string;
    const stop = async () => {
      await as(
        'jane',
        request(b.app).post(`/sessions/${id}/runs/${runId}/cancel`),
      ).expect(202);
      await pending;
    };
    return { id, runId, stop };
  }

  it('stores the references on the message and gives them to the model before the text', async () => {
    const b = await start([[say('answer')]]);
    const id = await newSession(b);
    await send(b, id, {
      page: { path: '/catalog' },
      references: [SHOP, SECRET, SNIPPET],
    }).expect(200);

    const [message] = await userMessages(id);
    expect(message).toMatchObject({
      text: 'what now?',
      references: [STORED_SHOP, STORED_SECRET, SNIPPET],
    });
    // Read with the credentials of the user who sent the message.
    expect(
      entities.reads.map(read => [read.entityRef, read.principal.userRef]),
    ).toEqual([
      ['component:default/shop', 'user:default/jane'],
      ['component:default/secret', 'user:default/jane'],
    ]);
    const [content] = userTexts(b.model.inputs[0]);
    expect(content.startsWith('The user is on the page "/catalog".\n')).toBe(
      true,
    );
    expect(content).toContain(
      'Reference 1: the entity "component:default/shop":',
    );
    expect(content).toContain('"owner": "group:default/team-a"');
    expect(content).toContain(
      'Reference 2: the entity "component:default/secret", whose details are not available to this user.',
    );
    expect(content).not.toContain('security team');
    expect(content).toContain(
      'Reference 3: a text titled "Runbook" from "https://example.com/runbook":\n"Restart the pods one at a time."',
    );
    expect(content.endsWith('\n\nwhat now?')).toBe(true);
    expect(b.model.inputs[0].system).not.toContain('component:default/shop');
  });

  it('does not read the entity again for the next step or the next run', async () => {
    const b = await start([
      [callTool('m1', 'demo:read', { name: 'x' })],
      [say('first')],
      [say('second')],
    ]);
    const id = await newSession(b);
    await send(b, id, { references: [SHOP] }).expect(200);
    await send(b, id, { text: 'and then?' }).expect(200);

    expect(entities.reads).toHaveLength(1);
    expect(b.model.inputs).toHaveLength(3);
    for (const input of b.model.inputs) {
      expect(userTexts(input)[0]).toContain('"title": "Shop"');
    }
    expect(userTexts(b.model.inputs[2])[1]).toBe('and then?');
  });

  it('refuses with 400 a body over the limits of the references, and writes nothing', async () => {
    const b = await start([[say('answer')]]);
    const id = await newSession(b);
    const text = (extra: object) => ({ kind: 'text', text: 'x', ...extra });
    const bad: unknown[] = [
      Array.from({ length: 6 }, () => text({})),
      [text({ text: 'x'.repeat(4001) })],
      [text({ text: '' })],
      [text({ title: 'x'.repeat(201) })],
      [text({ url: 'javascript:alert(1)' })],
      [text({ url: '//example.com/x' })],
      [text({ url: 'example.com' })],
      [text({ url: `https://example.com/${'a'.repeat(2000)}` })],
      [text({ extra: true }), { kind: 'link', url: '/x' }],
      [{ kind: 'entity', entityRef: 'shop' }],
      [{ kind: 'entity', entityRef: 'component:default/x y' }],
      [{ kind: 'entity' }],
      'not a list',
    ];
    for (const references of bad) {
      const res = await send(b, id, { references });
      expect([references, res.status]).toEqual([references, 400]);
    }
    expect(await world.items.read(id)).toEqual([]);
    expect(await world.knex('runs').where({ session_id: id })).toEqual([]);
    expect(entities.reads).toEqual([]);
    // The longest values that are allowed.
    await send(b, id, {
      references: [
        text({
          text: 'x'.repeat(4000),
          title: 't'.repeat(200),
          url: `/${'a'.repeat(1999)}`,
        }),
      ],
    }).expect(200);
  });

  it('refuses with 400 more references than aiChat.input.references.maxPerMessage', async () => {
    const b = await start([[say('answer')]], { maxReferences: 2 });
    const id = await newSession(b);
    const res = await send(b, id, {
      references: [SNIPPET, SNIPPET, SNIPPET],
    }).expect(400);
    expect(res.body.error).toMatchObject({
      name: 'TooManyReferences',
      message: 'A message may have at most 2 references',
    });
    expect(await world.items.read(id)).toEqual([]);
    await send(b, id, { references: [SNIPPET, SNIPPET] }).expect(200);
  });

  it('carries the references of an inserted message', async () => {
    const b = await start([waitForAbort]);
    const { id, runId, stop } = await blocked(b);
    const res = await as(
      'jane',
      request(b.app).post(`/sessions/${id}/runs/${runId}/messages`),
    )
      .send({ text: 'use this', references: [SNIPPET, SHOP] })
      .expect(201);
    expect(res.body).toMatchObject({
      kind: 'user_message',
      delivery: 'inserted',
      references: [SNIPPET, STORED_SHOP],
    });
    await as(
      'jane',
      request(b.app).post(`/sessions/${id}/runs/${runId}/messages`),
    )
      .send({ text: 'x', references: [{ kind: 'entity', entityRef: 'shop' }] })
      .expect(400);
    await stop();
    const [, inserted, ...rest] = await userMessages(id);
    expect(rest).toEqual([]);
    expect(inserted).toMatchObject({ references: [SNIPPET, STORED_SHOP] });
  });

  it('sends a queued message with its references, and a change of the queued message replaces them', async () => {
    const b = await start([
      [callTool('m1', 'demo:write', { name: 'x' })],
      [say('done')],
      [say('the queued answer')],
    ]);
    const id = await newSession(b);
    const first = await send(b, id, { text: 'change it' }).expect(200);
    const callId = /"toolCallId":"([^"]+)"/.exec(first.text)![1];
    const queued = await as(
      'jane',
      request(b.app).post(`/sessions/${id}/queue`),
    )
      .send({ text: 'next', references: [SECRET] })
      .expect(201);
    expect(queued.body.references).toEqual([STORED_SECRET]);
    const changed = await as(
      'jane',
      request(b.app).patch(`/sessions/${id}/queue/${queued.body.id}`),
    )
      .send({ references: [SHOP, SNIPPET] })
      .expect(200);
    expect(changed.body).toMatchObject({
      text: 'next',
      references: [STORED_SHOP, SNIPPET],
    });
    await as(
      'jane',
      request(b.app).patch(`/sessions/${id}/queue/${queued.body.id}`),
    )
      .send({ references: Array.from({ length: 6 }, () => SNIPPET) })
      .expect(400);
    const listed = await as(
      'jane',
      request(b.app).get(`/sessions/${id}/queue`),
    ).expect(200);
    expect(listed.body.items[0].references).toEqual([STORED_SHOP, SNIPPET]);
    const readsBefore = entities.reads.length;

    await as(
      'jane',
      request(b.app).post(`/sessions/${id}/tool-calls/${callId}/decision`),
    )
      .send({ approved: true })
      .expect(200);
    await until(() => b.model.inputs.length === 3);
    await until(async () => (await userMessages(id)).length === 2);

    const [, sent] = await userMessages(id);
    expect(sent).toMatchObject({
      text: 'next',
      delivery: 'queued',
      references: [STORED_SHOP, SNIPPET],
    });
    expect(userTexts(b.model.inputs[2])[1]).toContain('"title": "Shop"');
    // The queue keeps what it read: nothing is read when it sends.
    expect(entities.reads).toHaveLength(readsBefore);
  });

  it('inserts a queued message into the run with its references', async () => {
    const b = await start([waitForAbort]);
    const { id, runId, stop } = await blocked(b);
    const queued = await as(
      'jane',
      request(b.app).post(`/sessions/${id}/queue`),
    )
      .send({ text: 'now', references: [SNIPPET] })
      .expect(201);
    const none = await as('jane', request(b.app).post(`/sessions/${id}/queue`))
      .send({ text: 'plain', references: [SHOP] })
      .expect(201);
    const cleared = await as(
      'jane',
      request(b.app).patch(`/sessions/${id}/queue/${none.body.id}`),
    )
      .send({ references: [] })
      .expect(200);
    expect(cleared.body).not.toHaveProperty('references');

    const inserted = await as(
      'jane',
      request(b.app).post(`/sessions/${id}/queue/${queued.body.id}/insert`),
    )
      .send({ runId })
      .expect(201);
    expect(inserted.body).toMatchObject({
      text: 'now',
      delivery: 'inserted',
      references: [SNIPPET],
    });
    await stop();
  });

  it('shows the references of a message to the user it is shared with, and a copy takes them', async () => {
    const b = await start([[say('answer')]]);
    const id = await newSession(b);
    await send(b, id, { references: [SHOP, SNIPPET] }).expect(200);
    await as('jane', request(b.app).post(`/sessions/${id}/shares`))
      .send({ subjectRef: 'user:default/bob' })
      .expect(201);
    const seen = await as('bob', request(b.app).get(`/sessions/${id}`)).expect(
      200,
    );
    const message = seen.body.items.find(
      (item: { kind: string }) => item.kind === 'user_message',
    );
    expect(message.references).toEqual([STORED_SHOP, SNIPPET]);

    // A copy takes the references with the message.
    const copy = await as(
      'bob',
      request(b.app).post(`/sessions/${id}/fork`),
    ).expect(201);
    const [copied] = await userMessages(copy.body.id);
    expect(copied).toMatchObject({ references: [STORED_SHOP, SNIPPET] });
  });

  it('answers the limits of the references in GET /input-config', () => {
    const config = inputConfigOf({
      images: testInputConfig.images,
      insertMaxPerRun: 5,
      queueMaxMessages: 5,
      references: { maxPerMessage: 3 },
    });
    expect(config.references).toEqual({
      maxPerMessage: 3,
      maxTextLength: 4000,
    });
  });
});

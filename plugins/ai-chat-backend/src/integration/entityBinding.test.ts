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
import type { ContextProvider } from '@kwkevinchan/ai-chat-harness';
import { say } from '@kwkevinchan/ai-chat-harness/testing';
import express from 'express';
import request from 'supertest';
import { principalFromRequest } from '../adapters/backstage/principalFromRequest';
import { createRouter } from '../adapters/http';
import { entityContextProvider } from '../application';
import {
  createWorld,
  FakeEntityReader,
  testInputConfig,
} from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;

const JANE = mockCredentials.user.header('user:default/jane');
const MALLORY = mockCredentials.user.header('user:default/mallory');
const SHOP_PAGE = {
  path: '/catalog/default/component/shop',
  entityRef: 'component:default/shop',
};
const NOT_AVAILABLE = 'but its details are not available to this user';

/**
 * Binding a session to an entity (SE-02), listing the sessions of an entity
 * (SE-06) and the built-in provider `entity` (X-03), through the routes, on a
 * real database and a fake catalog.
 */
describe('sessions bound to an entity', () => {
  let world: World;
  let entities: FakeEntityReader;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  beforeEach(async () => {
    entities = new FakeEntityReader([
      { ref: 'component:default/shop', facts: { title: 'Shop' } },
      { ref: 'component:default/cart', facts: { title: 'Cart' } },
      {
        ref: 'component:default/secret',
        facts: { description: 'Only for the security team.' },
        readers: ['user:default/mallory'],
      },
    ]);
    world = await createWorld({ entities });
  });

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(
    script: Parameters<World['backend']>[0] = [],
    providers: ContextProvider[] = [],
  ) {
    const b = world.backend(script, {
      extensions: {
        contextProviders: [entityContextProvider(entities), ...providers],
      },
    });
    open.push(b.supervisor);
    const httpAuth = mockServices.httpAuth();
    const userInfo = mockServices.userInfo();
    const auth = mockServices.auth();
    const app = express()
      .use(
        createRouter({
          principal: req =>
            principalFromRequest(req, { httpAuth, userInfo, auth }),
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

  type B = ReturnType<typeof backend>;

  const create = (b: B, body: object = {}, user = JANE) =>
    request(b.app).post('/sessions').set('Authorization', user).send(body);

  const send = (b: B, id: string, body: object) =>
    request(b.app)
      .post(`/sessions/${id}/runs`)
      .set('Authorization', JANE)
      .send({ text: 'what is this?', ...body });

  const entityOf = async (b: B, id: string) =>
    (
      await request(b.app)
        .get(`/sessions/${id}`)
        .set('Authorization', JANE)
        .expect(200)
    ).body.session.entityRef;

  const listed = async (b: B, query: object, user = JANE) =>
    (
      await request(b.app)
        .get('/sessions')
        .query(query)
        .set('Authorization', user)
        .expect(200)
    ).body.items.map((s: { id: string }) => s.id);

  describe('POST /sessions with an entityRef', () => {
    it('binds the session to the normalized ref of an entity the user can read', async () => {
      const b = backend();
      const res = await create(b, { entityRef: 'Component:Shop' }).expect(201);
      expect(res.body.entityRef).toBe('component:default/shop');
      expect(await entityOf(b, res.body.id)).toBe('component:default/shop');
      expect(entities.reads[0]).toMatchObject({
        entityRef: 'component:default/shop',
        principal: { userRef: 'user:default/jane' },
      });
    });

    it('refuses an entity that does not exist and one the user cannot read with the same 400, and makes no session', async () => {
      const b = backend();
      const missing = await create(b, {
        entityRef: 'component:default/gone',
      }).expect(400);
      const hidden = await create(b, {
        entityRef: 'component:default/secret',
      }).expect(400);
      expect(hidden.body.error.message).toBe(missing.body.error.message);
      expect(hidden.body.error.name).toBe('InputError');
      expect(await listed(b, {})).toEqual([]);
      // The one who can read it can bind to it.
      await create(
        b,
        { entityRef: 'component:default/secret' },
        MALLORY,
      ).expect(201);
    });

    it('refuses a ref without a kind, without asking the catalog', async () => {
      const b = backend();
      await create(b, { entityRef: 'shop' }).expect(400);
      expect(entities.reads).toEqual([]);
      expect(await listed(b, {})).toEqual([]);
    });

    it('makes no session when the catalog fails, and does not show its error', async () => {
      const b = backend();
      entities.failing = true;
      const res = await create(b, { entityRef: 'component:default/shop' });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('catalog.internal');
      entities.failing = false;
      expect(await listed(b, {})).toEqual([]);
    });

    it('does not change the binding with PATCH', async () => {
      const b = backend();
      const { body } = await create(b, {
        entityRef: 'component:default/shop',
      }).expect(201);
      await request(b.app)
        .patch(`/sessions/${body.id}`)
        .set('Authorization', JANE)
        .send({ entityRef: 'component:default/cart', pinned: true })
        .expect(200);
      expect(await entityOf(b, body.id)).toBe('component:default/shop');
    });
  });

  describe('the first message binds the session to the entity of its page', () => {
    it('binds an unbound session, and the run reads the entity already', async () => {
      const b = backend([[say('a shop')]]);
      const { body } = await create(b).expect(201);
      await send(b, body.id, { page: SHOP_PAGE }).expect(200);
      expect(await entityOf(b, body.id)).toBe('component:default/shop');
      expect(b.model.inputs[0].system).toContain(
        'The session is about "component:default/shop".',
      );
      expect(b.model.inputs[0].system).toContain('"title": "Shop"');
    });

    it('binds only at the first message: a later page does not change it', async () => {
      const b = backend([[say('one')], [say('two')]]);
      const { body } = await create(b).expect(201);
      await send(b, body.id, {}).expect(200);
      await send(b, body.id, { page: SHOP_PAGE }).expect(200);
      expect(await entityOf(b, body.id)).toBeUndefined();

      const second = await create(b).expect(201);
      const c = backend([[say('one')], [say('two')]]);
      await send(c, second.body.id, { page: SHOP_PAGE }).expect(200);
      await send(c, second.body.id, {
        page: {
          path: '/catalog/default/component/cart',
          entityRef: 'component:default/cart',
        },
      }).expect(200);
      expect(await entityOf(c, second.body.id)).toBe('component:default/shop');
      expect(c.model.inputs[1].system).toContain(
        'The session is about "component:default/shop".',
      );
      // The page of the message is still in the message, as before.
      const last = c.model.inputs[1].messages.at(-1)!;
      expect(last.content).toContain(
        'The user is on the page of "component:default/cart"',
      );
    });

    it('keeps the binding the session was made with', async () => {
      const b = backend([[say('a cart')]]);
      const { body } = await create(b, {
        entityRef: 'component:default/cart',
      }).expect(201);
      await send(b, body.id, { page: SHOP_PAGE }).expect(200);
      expect(await entityOf(b, body.id)).toBe('component:default/cart');
      expect(b.model.inputs[0].system).toContain(
        'The session is about "component:default/cart".',
      );
    });

    it.each([
      ['an entity the user cannot read', 'component:default/secret', false],
      ['an entity that does not exist', 'component:default/gone', false],
      ['a ref without a kind', 'shop', false],
      ['a catalog that fails', 'component:default/shop', true],
    ])(
      'leaves the session unbound for %s, and the message goes on',
      async (_name, entityRef, failing) => {
        const b = backend([[say('answer')]]);
        const { body } = await create(b).expect(201);
        entities.failing = failing;
        const res = await send(b, body.id, {
          page: { path: '/catalog/x', entityRef },
        }).expect(200);
        entities.failing = false;
        expect(res.text).toContain('answer');
        expect(res.text).not.toContain('catalog.internal');
        expect(await entityOf(b, body.id)).toBeUndefined();
        expect(b.model.inputs).toHaveLength(1);
        expect(b.model.inputs[0].system).not.toContain('The session is about');
        expect(b.model.inputs[0].system).not.toContain('security team');
      },
    );
  });

  describe('the provider entity at every step', () => {
    it('says the context is not available when the catalog fails at a later step, and the run goes on', async () => {
      const b = backend([[say('one')], [say('two')]]);
      const { body } = await create(b, {
        entityRef: 'component:default/shop',
      }).expect(201);
      await send(b, body.id, {}).expect(200);
      entities.failing = true;
      await send(b, body.id, {}).expect(200);
      expect(b.model.inputs[1].system).toContain(
        'Context from "entity":\n> (not available in this step)',
      );
      expect(b.model.inputs[1].system).not.toContain(NOT_AVAILABLE);
    });

    it('does not put the text of a provider in the stream or the log', async () => {
      const b = backend(
        [[say('done')]],
        [{ id: 'secret-notes', provide: () => 'ONLY FOR THE MODEL' }],
      );
      const { body } = await create(b).expect(201);
      const res = await send(b, body.id, {}).expect(200);
      expect(b.model.inputs[0].system).toContain('> ONLY FOR THE MODEL');
      expect(res.text).not.toContain('ONLY FOR THE MODEL');
      const detail = await request(b.app)
        .get(`/sessions/${body.id}`)
        .set('Authorization', JANE)
        .expect(200);
      expect(JSON.stringify(detail.body)).not.toContain('ONLY FOR THE MODEL');
    });
  });

  describe('GET /sessions?entityRef= (SE-06)', () => {
    it('lists only the own sessions bound to that entity, with the ref normalized', async () => {
      const b = backend();
      const shop = (
        await create(b, { entityRef: 'component:default/shop' }).expect(201)
      ).body.id;
      await create(b, { entityRef: 'component:default/cart' }).expect(201);
      await create(b).expect(201);
      await create(b, { entityRef: 'component:default/shop' }, MALLORY).expect(
        201,
      );

      expect(await listed(b, { entityRef: 'component:default/shop' })).toEqual([
        shop,
      ]);
      expect(await listed(b, { entityRef: 'Component:Shop' })).toEqual([shop]);
      expect(await listed(b, { entityRef: 'component:default/none' })).toEqual(
        [],
      );
      expect(
        await listed(b, { entityRef: 'component:default/shop' }, MALLORY),
      ).toHaveLength(1);
    });

    it.each([['shop'], ['component:default/x y'], ['']])(
      'refuses the entityRef %j with 400',
      async entityRef => {
        const b = backend();
        const res = await request(b.app)
          .get('/sessions')
          .query({ entityRef })
          .set('Authorization', JANE);
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('entityRef');
      },
    );
  });
});

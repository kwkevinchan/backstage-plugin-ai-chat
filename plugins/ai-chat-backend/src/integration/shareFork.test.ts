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
import express from 'express';
import request from 'supertest';
import { createRouter } from '../adapters/http';
import { IMAGES } from '../__testUtils__/images';
import type { Principal } from '../domain';
import { createWorld, testInputConfig } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']> & { app: express.Express };

const HOUR = 3600;
const read = (name = 'x') => [callTool('m1', 'demo:read', { name })];

describe('forking a shared session and shared view metadata (P2-05)', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];
  const groups = new Map<string, string[]>();

  afterEach(async () => {
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

  async function upload(b: Backend, id: string, type: keyof typeof IMAGES) {
    const res = await as(
      'jane',
      request(b.app)
        .post(`/sessions/${id}/attachments`)
        .query({ name: 'pic' })
        .set('Content-Type', type),
    )
      .send(IMAGES[type])
      .expect(201);
    return res.body.id as string;
  }

  it('copies only visible messages and plans without tool calls, tool outputs, approvals, summaries, or notes (SH-04, section 5)', async () => {
    const b = await start([read('orders'), [say('Here is the answer.')]]);
    const id = await newSession(b);
    await send(b, id, 'Check orders');

    // Add a plan_update, a summary (contains tool output), and a note directly to the log.
    await world.sessions.seedItems!(id, [
      {
        kind: 'plan_update',
        plan: {
          items: [{ text: 'Inspect', status: 'completed' }],
        },
      },
      {
        kind: 'summary',
        coversUpToSeq: 4,
        text: 'SECRET_TOOL_OUTPUT_IN_SUMMARY',
      },
      { kind: 'note', text: 'internal note' },
    ]);

    // Share as snapshot up to here.
    await as('jane', request(b.app).post(`/sessions/${id}/shares`))
      .send({ subjectRef: 'user:default/bob', mode: 'snapshot' })
      .expect(201);

    // Add another message AFTER the snapshot (must not be copied).
    await world.sessions.seedItems!(id, [
      { kind: 'user_message', text: 'After snapshot secret' },
    ]);

    const forked = (
      await as('bob', request(b.app).post(`/sessions/${id}/fork`)).expect(201)
    ).body;
    expect(forked.ownerRef).toBe('user:default/bob');
    expect(forked.id).not.toBe(id);

    const detail = (
      await as('bob', request(b.app).get(`/sessions/${forked.id}`)).expect(200)
    ).body;
    expect(detail.shared).toBeUndefined();
    expect(detail.items.map((item: any) => item.kind)).toEqual([
      'user_message',
      'agent_message',
      'plan_update',
    ]);
    expect(detail.items[0].text).toBe('Check orders');
    expect(detail.items[1].text).toBe('Here is the answer.');
    expect(detail.items[2].plan.items[0].text).toBe('Inspect');
    expect(JSON.stringify(detail.items)).not.toContain(
      'SECRET_TOOL_OUTPUT_IN_SUMMARY',
    );
    expect(JSON.stringify(detail.items)).not.toContain('After snapshot secret');
    expect(detail.queue.items).toEqual([]);

    // Audit event recorded (SH-06).
    const forkEvents = world.audit.events.filter(
      e => e.eventId === 'session-fork',
    );
    expect(forkEvents).toHaveLength(1);
    expect(forkEvents[0]).toMatchObject({
      eventId: 'session-fork',
      actorRef: 'user:default/bob',
      sourceSessionId: id,
      sessionId: forked.id,
      copiedItems: 3,
      copiedAttachments: 0,
      outcome: 'success',
    });
  });

  it('copies visible images as new isolated attachments owned by the forker and omits out-of-scope or unused images (IN-19, section 5)', async () => {
    const b = await start([
      [say('Got first image.')],
      [say('Got second image.')],
    ]);
    const id = await newSession(b);
    const inScopeId = await upload(b, id, 'image/png');
    await send(b, id, 'First with image', { attachmentIds: [inScopeId] });

    // Unused attachment in the same session (must not be copied).
    const unusedId = await upload(b, id, 'image/jpeg');

    // Share snapshot covering the first message only.
    const shareRes = await as(
      'jane',
      request(b.app).post(`/sessions/${id}/shares`),
    )
      .send({ subjectRef: 'user:default/bob', mode: 'snapshot' })
      .expect(201);

    // Second message with another image AFTER the snapshot (must not be copied).
    const afterScopeId = await upload(b, id, 'image/png');
    await send(b, id, 'Second after snapshot', {
      attachmentIds: [afterScopeId],
    });

    const forked = (
      await as('bob', request(b.app).post(`/sessions/${id}/fork`)).expect(201)
    ).body;

    const detail = (
      await as('bob', request(b.app).get(`/sessions/${forked.id}`)).expect(200)
    ).body;
    expect(detail.items).toHaveLength(2);
    const copiedAtts = detail.items[0].attachments;
    expect(copiedAtts).toHaveLength(1);
    const copiedId = copiedAtts[0].id as string;
    expect(copiedId).not.toBe(inScopeId);

    // Bob can read the copied attachment with identical bytes.
    const readCopied = await as(
      'bob',
      request(b.app).get(`/sessions/${forked.id}/attachments/${copiedId}`),
    ).expect(200);
    expect(Buffer.from(readCopied.body)).toEqual(IMAGES['image/png']);

    // Cross-session attachment isolation: old IDs do not work on the forked session,
    // and the new ID does not work on the source session.
    await as(
      'bob',
      request(b.app).get(`/sessions/${forked.id}/attachments/${inScopeId}`),
    ).expect(404);
    await as(
      'bob',
      request(b.app).get(`/sessions/${forked.id}/attachments/${unusedId}`),
    ).expect(404);
    await as(
      'bob',
      request(b.app).get(`/sessions/${forked.id}/attachments/${afterScopeId}`),
    ).expect(404);
    await as(
      'jane',
      request(b.app).get(`/sessions/${id}/attachments/${copiedId}`),
    ).expect(404);

    // Revoking the original share does not revoke Bob's forked session or its images.
    await as(
      'jane',
      request(b.app).delete(`/sessions/${id}/shares/${shareRes.body.id}`),
    ).expect(204);
    await as('bob', request(b.app).get(`/sessions/${id}`)).expect(404);
    await as('bob', request(b.app).get(`/sessions/${forked.id}`)).expect(200);
    await as(
      'bob',
      request(b.app).get(`/sessions/${forked.id}/attachments/${copiedId}`),
    ).expect(200);

    const forkEvents = world.audit.events.filter(
      e => e.eventId === 'session-fork',
    );
    expect(forkEvents[0]).toMatchObject({
      copiedItems: 2,
      copiedAttachments: 1,
      outcome: 'success',
    });
  });

  it('returns 404 and writes no audit when the caller cannot read the session (SH-04, SH-06)', async () => {
    const b = await start([[say('hi')]]);
    const id = await newSession(b);
    await send(b, id, 'hello');

    // Stranger cannot fork.
    await as('mallory', request(b.app).post(`/sessions/${id}/fork`)).expect(
      404,
    );

    // Group member who leaves the group cannot fork.
    groups.set('bob', ['group:default/team']);
    await as('jane', request(b.app).post(`/sessions/${id}/shares`))
      .send({ subjectRef: 'group:default/team', mode: 'snapshot' })
      .expect(201);
    groups.delete('bob');
    await as('bob', request(b.app).post(`/sessions/${id}/fork`)).expect(404);

    expect(
      world.audit.events.filter(e => e.eventId === 'session-fork'),
    ).toHaveLength(0);
  });

  it('reports shared mode metadata on GET /sessions/:id and advances snapshotAt on refresh (SH-12)', async () => {
    const b = await start([[say('hello')], [say('later reply')]]);
    const id = await newSession(b);
    await send(b, id, 'hi');

    // Owner has no `shared` field.
    const ownerDetail = (
      await as('jane', request(b.app).get(`/sessions/${id}`)).expect(200)
    ).body;
    expect(ownerDetail.shared).toBeUndefined();
    const firstLastCreatedAt =
      ownerDetail.items[ownerDetail.items.length - 1].createdAt;

    // Snapshot sharee sees mode: 'snapshot' with snapshotAt = last visible item createdAt.
    const snapShare = (
      await as('jane', request(b.app).post(`/sessions/${id}/shares`))
        .send({ subjectRef: 'user:default/bob', mode: 'snapshot' })
        .expect(201)
    ).body;
    const snapDetail = (
      await as('bob', request(b.app).get(`/sessions/${id}`)).expect(200)
    ).body;
    expect(snapDetail.shared).toEqual({
      mode: 'snapshot',
      snapshotAt: firstLastCreatedAt,
    });

    // Advance clock, send another message, and refresh snapshot: snapshotAt moves forward.
    world.clock.advance(5 * HOUR * 1000);
    await send(b, id, 'second turn');
    await as(
      'jane',
      request(b.app).patch(`/sessions/${id}/shares/${snapShare.id}`),
    )
      .send({ refresh: true })
      .expect(200);
    const refreshedOwner = (
      await as('jane', request(b.app).get(`/sessions/${id}`)).expect(200)
    ).body;
    const secondLastCreatedAt =
      refreshedOwner.items[refreshedOwner.items.length - 1].createdAt;
    expect(secondLastCreatedAt > firstLastCreatedAt).toBe(true);

    const refreshedSnap = (
      await as('bob', request(b.app).get(`/sessions/${id}`)).expect(200)
    ).body;
    expect(refreshedSnap.shared).toEqual({
      mode: 'snapshot',
      snapshotAt: secondLastCreatedAt,
    });

    // Live sharee sees mode: 'live' with expiresAt; once expired, becomes mode: 'snapshot'.
    const liveShare = (
      await as('jane', request(b.app).post(`/sessions/${id}/shares`))
        .send({ subjectRef: 'user:default/carol', mode: 'live', hours: 2 })
        .expect(201)
    ).body;
    const liveDetail = (
      await as('carol', request(b.app).get(`/sessions/${id}`)).expect(200)
    ).body;
    expect(liveDetail.shared).toEqual({
      mode: 'live',
      expiresAt: liveShare.expiresAt,
    });

    world.clock.advance(3 * HOUR * 1000);
    const expiredDetail = (
      await as('carol', request(b.app).get(`/sessions/${id}`)).expect(200)
    ).body;
    expect(expiredDetail.shared).toEqual({
      mode: 'snapshot',
      snapshotAt: secondLastCreatedAt,
    });
  });

  it('returns 404 and writes no session-fork audit after a share is revoked (SH-06)', async () => {
    const b = await start([[say('hi')]]);
    const id = await newSession(b);
    await send(b, id, 'hello');

    const share = (
      await as('jane', request(b.app).post(`/sessions/${id}/shares`))
        .send({ subjectRef: 'user:default/bob', mode: 'snapshot' })
        .expect(201)
    ).body;
    await as(
      'jane',
      request(b.app).delete(`/sessions/${id}/shares/${share.id}`),
    ).expect(204);

    await as('bob', request(b.app).post(`/sessions/${id}/fork`)).expect(404);
    expect(
      world.audit.events.filter(e => e.eventId === 'session-fork'),
    ).toHaveLength(0);
  });

  it('returns 404 when access.canReadSession denies even the owner on fork (SH-05)', async () => {
    const b = await start([[say('hi')]], {
      access: {
        canReadSession: async () => false,
        usableToolsets: async ({ toolsetIds }) => [...toolsetIds],
      },
    });
    const id = await newSession(b);
    await send(b, id, 'hello');

    await as('jane', request(b.app).post(`/sessions/${id}/fork`)).expect(404);
    expect(
      world.audit.events.filter(e => e.eventId === 'session-fork'),
    ).toHaveLength(0);
  });

  it('excludes messages sent after a live share expired when the recipient forks (SH-04, SH-06)', async () => {
    const b = await start([[say('before expiry')], [say('after expiry')]]);
    const id = await newSession(b);
    await send(b, id, 'first question');

    await as('jane', request(b.app).post(`/sessions/${id}/shares`))
      .send({ subjectRef: 'user:default/bob', mode: 'live', hours: 1 })
      .expect(201);

    // Expire the live share, then owner sends a new turn.
    world.clock.advance(2 * HOUR * 1000);
    await send(b, id, 'secret after expiry');

    const forked = (
      await as('bob', request(b.app).post(`/sessions/${id}/fork`)).expect(201)
    ).body;
    const forkedDetail = (
      await as('bob', request(b.app).get(`/sessions/${forked.id}`)).expect(200)
    ).body;
    const texts = forkedDetail.items
      .filter((i: { text?: string }) => typeof i.text === 'string')
      .map((i: { text: string }) => i.text);
    expect(texts).toContain('first question');
    expect(texts).toContain('before expiry');
    expect(texts).not.toContain('secret after expiry');
    expect(texts).not.toContain('after expiry');
  });
});

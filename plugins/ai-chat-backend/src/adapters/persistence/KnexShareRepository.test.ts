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

import { NEW_SESSION, createPersistence } from './__testUtils__';

describe('KnexShareRepository', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;

  beforeEach(async () => {
    p = await createPersistence();
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('writes a share and reads it back, including a null bound and an output bound of 0', async () => {
    const session = await p.sessions.create(NEW_SESSION);
    const hidden = await p.shares.add({
      sessionId: session.id,
      subjectRef: 'user:default/bob',
      outputsUpToSeq: 0,
      createdBy: 'user:default/jane',
    });
    const open = await p.shares.add({
      sessionId: session.id,
      subjectRef: 'group:default/team',
      upToSeq: 4,
      outputsUpToSeq: 2,
      expiresAt: '2026-02-01T00:00:00.000Z',
      createdBy: 'user:default/jane',
    });
    const listed = await p.shares.listBySession(session.id);
    expect(listed).toEqual([hidden, open]);
    expect(hidden.outputsUpToSeq).toBe(0);
    expect(hidden.upToSeq).toBeUndefined();
    expect(hidden.expiresAt).toBeUndefined();
    expect(hidden.revokedAt).toBeUndefined();
    const raw = await p.knex('shares').where({ id: hidden.id }).first();
    expect(raw.outputs_up_to_seq).toBe(0);
    expect(raw.up_to_seq).toBeNull();
    expect(raw.revoked_at).toBeNull();
  });

  it('lists the active shares of the given subjects and leaves out revoked and other subjects', async () => {
    const session = await p.sessions.create(NEW_SESSION);
    const other = await p.sessions.create({
      ...NEW_SESSION,
      ownerRef: 'user:default/other',
    });
    const bob = await p.shares.add({
      sessionId: session.id,
      subjectRef: 'user:default/bob',
      createdBy: session.ownerRef,
    });
    p.clock.advance(1);
    const team = await p.shares.add({
      sessionId: session.id,
      subjectRef: 'group:default/team',
      createdBy: session.ownerRef,
    });
    const cancelled = await p.shares.add({
      sessionId: session.id,
      subjectRef: 'user:default/cara',
      createdBy: session.ownerRef,
    });
    await p
      .knex('shares')
      .where({ id: cancelled.id })
      .update({ revoked_at: '2026-03-01T00:00:00.000Z' });
    await p.shares.add({
      sessionId: other.id,
      subjectRef: 'user:default/bob',
      createdBy: other.ownerRef,
    });

    expect(
      await p.shares.listActiveFor(session.id, [
        'user:default/bob',
        'group:default/team',
        'user:default/cara',
      ]),
    ).toEqual([bob, team]);
    expect(
      await p.shares.listActiveFor(session.id, ['user:default/cara']),
    ).toEqual([]);
    expect(
      await p.shares.listActiveFor(session.id, ['user:default/nobody']),
    ).toEqual([]);
  });

  it('lists every share of a session, including a revoked one', async () => {
    const session = await p.sessions.create(NEW_SESSION);
    const share = await p.shares.add({
      sessionId: session.id,
      subjectRef: 'user:default/bob',
      createdBy: session.ownerRef,
    });
    await p
      .knex('shares')
      .where({ id: share.id })
      .update({ revoked_at: '2026-03-01T00:00:00.000Z' });
    const [listed] = await p.shares.listBySession(session.id);
    expect(listed.revokedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('lists nothing when there is no subject to match', async () => {
    const session = await p.sessions.create(NEW_SESSION);
    await p.shares.add({
      sessionId: session.id,
      subjectRef: 'user:default/bob',
      createdBy: session.ownerRef,
    });
    expect(await p.shares.listActiveFor(session.id, [])).toEqual([]);
  });
});

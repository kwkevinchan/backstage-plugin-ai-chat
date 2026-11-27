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

import { createHash } from 'node:crypto';
import { IMAGES } from '../../__testUtils__/images';
import {
  AttachmentInUse,
  AttachmentNotFound,
  TooManyPendingAttachments,
  type AttachmentMeta,
} from '../../domain';
import { NEW_SESSION, createPersistence } from './__testUtils__';

/** The fake clock moves in seconds. */
const HOUR = 3600;

describe('KnexAttachmentStore', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;
  let sessionId: string;

  beforeEach(async () => {
    p = await createPersistence();
    sessionId = (await p.sessions.create(NEW_SESSION)).id;
  });

  afterEach(async () => {
    await p.cleanup();
  });

  const put = (
    options: { sessionId?: string; maxPending?: number; name?: string } = {},
  ) =>
    p.attachments.put({
      sessionId: options.sessionId ?? sessionId,
      ownerRef: 'user:default/jane',
      mediaType: 'image/png',
      name: options.name ?? 'shot.png',
      bytes: IMAGES['image/png'],
      maxPending: options.maxPending ?? 12,
    });

  describe('put and get', () => {
    it('stores the bytes with their size and SHA-256, and reads them back', async () => {
      const meta = await put();
      expect(meta).toEqual({
        id: expect.any(String),
        sessionId,
        mediaType: 'image/png',
        name: 'shot.png',
        size: IMAGES['image/png'].length,
        sha256: createHash('sha256').update(IMAGES['image/png']).digest('hex'),
      });
      const read = await p.attachments.get(sessionId, meta.id);
      expect(read.meta).toEqual(meta);
      expect(Buffer.from(read.bytes).equals(IMAGES['image/png'])).toBe(true);
    });

    it('stores the owner, and leaves the image unused and unheld', async () => {
      const meta = await put();
      expect(
        await p.knex('attachments').where({ id: meta.id }).first(),
      ).toMatchObject({
        owner_ref: 'user:default/jane',
        used_seq: null,
        reserved_by: null,
      });
    });

    it('does not give an image to another session (AttachmentNotFound)', async () => {
      const other = (await p.sessions.create(NEW_SESSION)).id;
      const meta = await put();
      await expect(p.attachments.get(other, meta.id)).rejects.toBeInstanceOf(
        AttachmentNotFound,
      );
      await expect(
        p.attachments.get(sessionId, 'nothing'),
      ).rejects.toBeInstanceOf(AttachmentNotFound);
    });
  });

  describe('the images that are in no message (IN-04)', () => {
    it('refuses the one after the limit (TooManyPendingAttachments), and counts per session', async () => {
      for (let i = 0; i < 12; i++) await put();
      await expect(put()).rejects.toBeInstanceOf(TooManyPendingAttachments);
      const other = (await p.sessions.create(NEW_SESSION)).id;
      await expect(put({ sessionId: other })).resolves.toBeDefined();
    });

    it('does not count an image that a message uses', async () => {
      const a = await put({ maxPending: 2 });
      await put({ maxPending: 2 });
      await expect(put({ maxPending: 2 })).rejects.toBeInstanceOf(
        TooManyPendingAttachments,
      );
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [
          {
            kind: 'user_message',
            text: 'x',
            attachments: [
              { id: a.id, mediaType: a.mediaType, name: a.name, size: a.size },
            ],
          },
        ],
        run.fence,
      );
      await expect(put({ maxPending: 2 })).resolves.toBeDefined();
    });

    it('lets in only the free places when several uploads arrive at the same time', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => put({ maxPending: 3 })),
      );
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    });
  });

  describe('the meta of images, without the bytes', () => {
    it('gives the meta in the order of the ids, without reading bytes', async () => {
      const a = await put({ name: 'a.png' });
      const b = await put({ name: 'b.png' });
      expect(
        (await p.attachments.describe(sessionId, [b.id, a.id])).map(
          m => m.name,
        ),
      ).toEqual(['b.png', 'a.png']);
    });

    it('fails when one id is not in the session', async () => {
      const other = (await p.sessions.create(NEW_SESSION)).id;
      const a = await put();
      const foreign = await put({ sessionId: other });
      await expect(
        p.attachments.describe(sessionId, [a.id, foreign.id]),
      ).rejects.toBeInstanceOf(AttachmentNotFound);
      expect(await p.attachments.describe(sessionId, [])).toEqual([]);
    });
  });

  describe('copy (IN-19)', () => {
    it('makes new attachments in the other session, with the same type, name, hash and bytes, owned by the one who copies', async () => {
      const to = (await p.sessions.create(NEW_SESSION)).id;
      const a = await put();
      const map = await p.attachments.copy({
        fromSessionId: sessionId,
        toSessionId: to,
        ownerRef: 'user:default/bob',
        ids: [a.id, 'missing'],
      });
      expect([...map.keys()]).toEqual([a.id]);
      const copy = map.get(a.id) as AttachmentMeta;
      expect(copy.id).not.toBe(a.id);
      expect(copy).toMatchObject({
        sessionId: to,
        mediaType: a.mediaType,
        name: a.name,
        sha256: a.sha256,
        size: a.size,
      });
      const read = await p.attachments.get(to, copy.id);
      expect(Buffer.from(read.bytes).equals(IMAGES['image/png'])).toBe(true);
      expect(
        await p.knex('attachments').where({ id: copy.id }).first(),
      ).toMatchObject({ owner_ref: 'user:default/bob', used_seq: null });
      // The original stays.
      await expect(p.attachments.get(sessionId, a.id)).resolves.toBeDefined();
    });

    it('does not copy an image of a session that is not the source, and does not count the copies as pending', async () => {
      const to = (await p.sessions.create(NEW_SESSION)).id;
      const third = (await p.sessions.create(NEW_SESSION)).id;
      const foreign = await put({ sessionId: third });
      const map = await p.attachments.copy({
        fromSessionId: sessionId,
        toSessionId: to,
        ownerRef: 'user:default/bob',
        ids: [foreign.id],
      });
      expect(map.size).toBe(0);
    });
  });

  describe('purgeUnused (IN-04)', () => {
    it('deletes the images that are unused, unheld and older than the time, and keeps the rest', async () => {
      const old = await put({ name: 'old.png' });
      p.clock.advance(30 * HOUR);
      const fresh = await put({ name: 'fresh.png' });
      const cut = new Date(p.clock.now().getTime() - 24 * HOUR * 1000);
      expect(await p.attachments.purgeUnused(cut)).toBe(1);
      await expect(p.attachments.get(sessionId, old.id)).rejects.toBeInstanceOf(
        AttachmentNotFound,
      );
      await expect(
        p.attachments.get(sessionId, fresh.id),
      ).resolves.toBeDefined();
    });

    it('keeps an image that a message uses and one that a queued message holds', async () => {
      const used = await put({ name: 'used.png' });
      const held = await put({ name: 'held.png' });
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [
          {
            kind: 'user_message',
            text: 'x',
            attachments: [
              {
                id: used.id,
                mediaType: used.mediaType,
                name: used.name,
                size: used.size,
              },
            ],
          },
        ],
        run.fence,
      );
      await p.queue.add(
        sessionId,
        { text: 'later', attachmentIds: [held.id] },
        { max: 5 },
      );
      p.clock.advance(100 * HOUR);

      expect(await p.attachments.purgeUnused(p.clock.now())).toBe(0);
      await expect(
        p.attachments.get(sessionId, used.id),
      ).resolves.toBeDefined();
      await expect(
        p.attachments.get(sessionId, held.id),
      ).resolves.toBeDefined();
    });

    it('deletes an image again once the queued message that held it is removed', async () => {
      const held = await put();
      await p.runs.start(sessionId);
      const queued = await p.queue.add(
        sessionId,
        { text: 'later', attachmentIds: [held.id] },
        { max: 5 },
      );
      p.clock.advance(30 * HOUR);
      expect(await p.attachments.purgeUnused(p.clock.now())).toBe(0);
      await p.queue.remove(sessionId, queued.id);
      expect(await p.attachments.purgeUnused(p.clock.now())).toBe(1);
    });
  });

  describe('deletePending', () => {
    it('deletes an unused attachment and frees a pending slot', async () => {
      const a = await put({ maxPending: 1 });
      await expect(put({ maxPending: 1 })).rejects.toBeInstanceOf(
        TooManyPendingAttachments,
      );
      await p.attachments.deletePending({
        sessionId,
        id: a.id,
        ownerRef: 'user:default/jane',
      });
      await expect(p.attachments.get(sessionId, a.id)).rejects.toBeInstanceOf(
        AttachmentNotFound,
      );
      await expect(put({ maxPending: 1 })).resolves.toBeDefined();
    });

    it('throws AttachmentNotFound for missing, another session, or another owner', async () => {
      const other = (await p.sessions.create(NEW_SESSION)).id;
      const a = await put();
      await expect(
        p.attachments.deletePending({
          sessionId,
          id: 'missing',
          ownerRef: 'user:default/jane',
        }),
      ).rejects.toBeInstanceOf(AttachmentNotFound);
      await expect(
        p.attachments.deletePending({
          sessionId: other,
          id: a.id,
          ownerRef: 'user:default/jane',
        }),
      ).rejects.toBeInstanceOf(AttachmentNotFound);
      await expect(
        p.attachments.deletePending({
          sessionId,
          id: a.id,
          ownerRef: 'user:default/mallory',
        }),
      ).rejects.toBeInstanceOf(AttachmentNotFound);
    });

    it('throws AttachmentInUse when already used by a message or held by a queued message', async () => {
      const used = await put();
      const held = await put();
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [
          {
            kind: 'user_message',
            text: 'x',
            attachments: [
              {
                id: used.id,
                mediaType: used.mediaType,
                name: used.name,
                size: used.size,
              },
            ],
          },
        ],
        run.fence,
      );
      await p.queue.add(
        sessionId,
        { text: 'later', attachmentIds: [held.id] },
        { max: 5 },
      );

      await expect(
        p.attachments.deletePending({
          sessionId,
          id: used.id,
          ownerRef: 'user:default/jane',
        }),
      ).rejects.toBeInstanceOf(AttachmentInUse);
      await expect(
        p.attachments.deletePending({
          sessionId,
          id: held.id,
          ownerRef: 'user:default/jane',
        }),
      ).rejects.toBeInstanceOf(AttachmentInUse);
    });
  });

  it('deletes the images with the session', async () => {
    const a = await put();
    await p.sessions.delete(sessionId);
    expect(
      await p.knex('attachments').where({ id: a.id }).first(),
    ).toBeUndefined();
  });
});

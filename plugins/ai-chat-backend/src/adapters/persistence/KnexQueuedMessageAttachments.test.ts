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

import { IMAGES } from '../../__testUtils__/images';
import { UnknownAttachment } from '../../domain';
import { NEW_SESSION, createPersistence } from './__testUtils__';

describe('KnexQueuedMessageRepository: the images of a queued message (IN-13, IN-04)', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;
  let sessionId: string;

  beforeEach(async () => {
    p = await createPersistence();
    sessionId = (await p.sessions.create(NEW_SESSION)).id;
    const run = await p.runs.start(sessionId);
    await p.items.append(
      sessionId,
      [{ kind: 'user_message', text: 'go' }],
      run.fence,
    );
  });

  afterEach(async () => {
    await p.cleanup();
  });

  const upload = (session = sessionId, name = 'shot.png') =>
    p.attachments.put({
      sessionId: session,
      ownerRef: 'user:default/jane',
      mediaType: 'image/png',
      name,
      bytes: IMAGES['image/png'],
      maxPending: 100,
    });
  const add = (text: string, ...attachmentIds: string[]) =>
    p.queue.add(sessionId, { text, attachmentIds }, { max: 5 });
  const row = (id: string) =>
    p.knex('attachments').where({ id }).first('used_seq', 'reserved_by');

  it('holds the images with the id of the queued message, and lists them in the message', async () => {
    const a = await upload(sessionId, 'a.png');
    const b = await upload(sessionId, 'b.png');
    const queued = await add('later', b.id, a.id);
    expect(queued.attachments.map(m => m.name)).toEqual(['b.png', 'a.png']);
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: queued.id });
    expect(await row(b.id)).toEqual({ used_seq: null, reserved_by: queued.id });
    expect(
      (await p.queue.list(sessionId))[0].attachments.map(m => m.name),
    ).toEqual(['b.png', 'a.png']);
  });

  it('refuses an image of another session and holds nothing (UnknownAttachment)', async () => {
    const other = (await p.sessions.create(NEW_SESSION)).id;
    const mine = await upload();
    const foreign = await upload(other);
    await expect(add('x', mine.id, foreign.id)).rejects.toBeInstanceOf(
      UnknownAttachment,
    );
    expect(await p.queue.list(sessionId)).toEqual([]);
    expect(await row(mine.id)).toEqual({ used_seq: null, reserved_by: null });
  });

  it('releases the images when the message is removed', async () => {
    const a = await upload();
    const queued = await add('later', a.id);
    await p.queue.remove(sessionId, queued.id);
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: null });
  });

  it('holds the new images and releases the ones left out when the images change', async () => {
    const a = await upload();
    const b = await upload();
    const queued = await add('later', a.id);
    const changed = await p.queue.update(sessionId, queued.id, {
      attachmentIds: [b.id],
    });
    expect(changed.attachments.map(m => m.id)).toEqual([b.id]);
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: null });
    expect(await row(b.id)).toEqual({ used_seq: null, reserved_by: queued.id });
    const cleared = await p.queue.update(sessionId, queued.id, {
      attachmentIds: [],
    });
    expect(cleared.attachments).toEqual([]);
    expect(await row(b.id)).toEqual({ used_seq: null, reserved_by: null });
  });

  it('keeps the text and the images when only the other one changes', async () => {
    const a = await upload();
    const queued = await add('later', a.id);
    const changed = await p.queue.update(sessionId, queued.id, { text: 'new' });
    expect(changed.attachments.map(m => m.id)).toEqual([a.id]);
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: queued.id });
  });

  it('refuses a change to an image of another session, and leaves the message as it was', async () => {
    const other = (await p.sessions.create(NEW_SESSION)).id;
    const a = await upload();
    const foreign = await upload(other);
    const queued = await add('later', a.id);
    await expect(
      p.queue.update(sessionId, queued.id, { attachmentIds: [foreign.id] }),
    ).rejects.toBeInstanceOf(UnknownAttachment);
    expect(
      (await p.queue.list(sessionId))[0].attachments.map(m => m.id),
    ).toEqual([a.id]);
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: queued.id });
  });

  it('keeps an image held while another queued message still lists it', async () => {
    const a = await upload();
    const first = await add('one', a.id);
    const second = await add('two', a.id);
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: first.id });
    await p.queue.remove(sessionId, first.id);
    // The hold passes to the message that still lists the image: it must not
    // be deleted while that message waits.
    expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: second.id });
    p.clock.advance(48 * 3600);
    expect(await p.attachments.purgeUnused(p.clock.now())).toBe(0);
  });

  describe('startNext', () => {
    it('writes the message with its images, sets used_seq to its seq and ends the hold', async () => {
      const a = await upload(sessionId, 'a.png');
      const b = await upload(sessionId, 'b.png');
      const queued = await add('later', a.id, b.id);
      await p.runs.transition(
        (await p.runs.findActive(sessionId))!.id,
        'completed',
      );

      const started = await p.queue.startNext(sessionId);

      expect(started?.message.attachments.map(m => m.id)).toEqual([a.id, b.id]);
      const items = await p.items.read(sessionId);
      const sent = items[items.length - 1];
      expect(sent).toMatchObject({
        kind: 'user_message',
        text: 'later',
        delivery: 'queued',
        runId: started!.run.id,
        attachments: [
          { id: a.id, mediaType: 'image/png', name: 'a.png', size: a.size },
          { id: b.id, mediaType: 'image/png', name: 'b.png', size: b.size },
        ],
      });
      expect(await row(a.id)).toEqual({
        used_seq: sent.seq,
        reserved_by: null,
      });
      expect(await row(b.id)).toEqual({
        used_seq: sent.seq,
        reserved_by: null,
      });
      expect(await p.queue.list(sessionId)).toEqual([]);
      expect(queued.id).toBeDefined();
    });

    it('leaves a held image held when it is for the message after', async () => {
      const a = await upload();
      await add('one');
      const second = await add('two', a.id);
      await p.runs.transition(
        (await p.runs.findActive(sessionId))!.id,
        'completed',
      );
      await p.queue.startNext(sessionId);
      expect(await row(a.id)).toEqual({
        used_seq: null,
        reserved_by: second.id,
      });
    });
  });
});

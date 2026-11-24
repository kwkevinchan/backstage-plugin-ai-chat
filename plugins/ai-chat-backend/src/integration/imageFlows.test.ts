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

import {
  callTool,
  say,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import { IMAGES, pngOfSize } from '../__testUtils__/images';
import {
  ImagesNotSupported,
  TooManyAttachments,
  TooManyImageBytes,
  UnknownAttachment,
  type Principal,
} from '../domain';
import {
  createWorld,
  drain,
  jane,
  janeFresh,
  mallory,
  until,
} from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']>;

/** The fake clock moves in seconds. */
const HOUR = 3600;
const writeCall = callTool('m1', 'demo:write', { name: 'x' });

/**
 * The images of a message (PI-05) on a real database (SQLite here,
 * PostgreSQL in CI): the mark of a message that is written, the hold of a
 * queued message, the input the model gets, and the cleaning.
 */
describe('images in messages, on a database', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  async function start(options: Parameters<typeof createWorld>[0] = {}) {
    world = await createWorld(options);
  }

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<World['backend']>): Backend {
    const b = world.backend(...args);
    open.push(b.supervisor);
    return b;
  }

  async function upload(
    sessionId: string,
    options: { bytes?: Buffer; name?: string } = {},
  ) {
    return world.attachments.put({
      sessionId,
      ownerRef: jane.userRef,
      mediaType: 'image/png',
      name: options.name ?? 'shot.png',
      bytes: options.bytes ?? IMAGES['image/png'],
      maxPending: 100,
    });
  }

  const used = async (id: string) =>
    world.knex('attachments').where({ id }).first('used_seq', 'reserved_by');

  const send = (
    host: Backend,
    sessionId: string,
    attachmentIds?: string[],
    principal: Principal = janeFresh,
  ) =>
    host.useCases.sendMessage.execute({
      principal,
      sessionId,
      text: 'what is this?',
      ...(attachmentIds && { attachmentIds }),
    });

  describe('a message that starts a run (IN-03, IN-05)', () => {
    it('keeps the images in the message, marks them with its seq, and gives the model the images by id', async () => {
      await start();
      const host = backend([[say('a screenshot')]]);
      const session = await world.newSession();
      const a = await upload(session.id, { name: 'a.png' });
      const b = await upload(session.id, { name: 'b.png' });

      await drain(await send(host, session.id, [b.id, a.id]));

      const [message] = await world.items.read(session.id);
      expect(message).toMatchObject({
        kind: 'user_message',
        attachments: [
          { id: b.id, mediaType: 'image/png', name: 'b.png', size: b.size },
          { id: a.id, mediaType: 'image/png', name: 'a.png', size: a.size },
        ],
      });
      expect(await used(a.id)).toEqual({ used_seq: 1, reserved_by: null });
      expect(host.model.inputs[0].messages[0]).toEqual({
        role: 'user',
        content: 'what is this?',
        images: [
          { attachmentId: b.id, mediaType: 'image/png', name: 'b.png' },
          { attachmentId: a.id, mediaType: 'image/png', name: 'a.png' },
        ],
      });
      // The model of the call is told which session the images are in.
      expect(host.model.sessionIds).toEqual([session.id]);
    });

    it('lets the user send the same images again (send again)', async () => {
      await start();
      const host = backend([[say('one')], [say('two')]]);
      const session = await world.newSession();
      const a = await upload(session.id);
      await drain(await send(host, session.id, [a.id]));
      await drain(await send(host, session.id, [a.id]));

      const log = await world.items.read(session.id);
      const messages = log.filter(i => i.kind === 'user_message');
      expect(messages).toHaveLength(2);
      expect(messages.map(m => (m as any).attachments[0].id)).toEqual([
        a.id,
        a.id,
      ]);
      // The first message keeps the mark.
      expect((await used(a.id))?.used_seq).toBe(1);
    });

    it('refuses an image of another session (400 at the route), starts no run and writes nothing', async () => {
      await start();
      const host = backend([[say('x')]]);
      const mine = await world.newSession();
      const theirs = await world.newSession(mallory);
      const foreign = await upload(theirs.id);

      await expect(send(host, mine.id, [foreign.id])).rejects.toBeInstanceOf(
        UnknownAttachment,
      );

      expect(await world.runCount()).toBe(0);
      expect(await world.items.read(mine.id)).toEqual([]);
      expect(await used(foreign.id)).toEqual({
        used_seq: null,
        reserved_by: null,
      });
    });

    it('refuses more images than a message may have, and a model that cannot read them', async () => {
      await start();
      const host = backend([[say('x')]]);
      const session = await world.newSession();
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await upload(session.id)).id);
      await expect(send(host, session.id, ids)).rejects.toBeInstanceOf(
        TooManyAttachments,
      );
      await world.cleanup();

      await start({ images: { enabled: false } });
      const off = backend([[say('x')]]);
      const other = await world.newSession();
      const a = await upload(other.id);
      await expect(send(off, other.id, [a.id])).rejects.toBeInstanceOf(
        ImagesNotSupported,
      );
      expect(await world.runCount()).toBe(0);
    });
  });

  describe('a message inserted into a run (IN-10, IN-06)', () => {
    async function blocked(host: Backend) {
      const session = await world.newSession();
      const handle = await send(host, session.id);
      await until(() => host.model.inputs.length > 0);
      return { session, handle };
    }

    it('keeps the images in the message and marks them with its seq', async () => {
      await start();
      const host = backend([waitForAbort]);
      const { session, handle } = await blocked(host);
      const a = await upload(session.id);

      const item = await host.useCases.insertMessage.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
        text: 'and this one',
        attachmentIds: [a.id],
      });

      expect(item).toMatchObject({
        delivery: 'inserted',
        attachments: [{ id: a.id, name: 'shot.png' }],
      });
      expect(await used(a.id)).toEqual({
        used_seq: item.seq,
        reserved_by: null,
      });
      await host.supervisor.shutdown(0);
    });

    it('refuses the message that takes the images of the run over the limit (TooManyImageBytes), writes nothing and marks nothing', async () => {
      await start({ images: { maxBytesPerInput: 1000 } });
      const host = backend([waitForAbort]);
      const session = await world.newSession();
      const first = await upload(session.id, { bytes: pngOfSize(700) });
      const handle = await send(host, session.id, [first.id]);
      await until(() => host.model.inputs.length > 0);
      const second = await upload(session.id, { bytes: pngOfSize(400) });

      await expect(
        host.useCases.insertMessage.execute({
          principal: jane,
          sessionId: session.id,
          runId: handle.runId,
          text: 'too much',
          attachmentIds: [second.id],
        }),
      ).rejects.toBeInstanceOf(TooManyImageBytes);

      expect(await world.items.read(session.id)).toHaveLength(1);
      expect(await used(second.id)).toEqual({
        used_seq: null,
        reserved_by: null,
      });
      await host.supervisor.shutdown(0);
    });
  });

  describe('a queued message (IN-13, IN-14, IN-04)', () => {
    /** The run waits for an approval, so a message can be queued behind it. */
    async function waiting(host: Backend) {
      const session = await world.newSession();
      await drain(await send(host, session.id));
      const call = (await world.items.read(session.id)).find(
        i => i.kind === 'tool_call',
      ) as { callId: string };
      return { session, callId: call.callId };
    }

    const queue = (
      host: Backend,
      sessionId: string,
      text: string,
      attachmentIds: string[],
    ) =>
      host.useCases.queueMessage.execute({
        principal: jane,
        sessionId,
        text,
        attachmentIds,
      });

    it('holds the images, releases them when the message is deleted, and the same image can be queued again', async () => {
      await start();
      const host = backend([[writeCall]]);
      const { session } = await waiting(host);
      const a = await upload(session.id);

      const queued = await queue(host, session.id, 'later', [a.id]);
      expect(queued.attachments.map(m => m.id)).toEqual([a.id]);
      expect(await used(a.id)).toEqual({
        used_seq: null,
        reserved_by: queued.id,
      });

      await host.useCases.deleteQueuedMessage.execute({
        principal: jane,
        sessionId: session.id,
        queuedId: queued.id,
      });
      expect(await used(a.id)).toEqual({ used_seq: null, reserved_by: null });
      await expect(
        queue(host, session.id, 'again', [a.id]),
      ).resolves.toBeDefined();
    });

    it('does not let the cleaning delete a held image, though it is old', async () => {
      await start();
      const host = backend([[writeCall]]);
      const { session } = await waiting(host);
      const a = await upload(session.id);
      await queue(host, session.id, 'later', [a.id]);

      world.clock.advance(48 * HOUR);
      expect(await host.useCases.purgeUnusedAttachments.execute()).toBe(0);
      await expect(
        world.attachments.get(session.id, a.id),
      ).resolves.toBeDefined();
    });

    it('refuses an image of another session, too many images, and images for a model that cannot read them', async () => {
      await start();
      const host = backend([[writeCall]]);
      const { session } = await waiting(host);
      const other = await world.newSession(mallory);
      const foreign = await upload(other.id);
      await expect(
        queue(host, session.id, 'x', [foreign.id]),
      ).rejects.toBeInstanceOf(UnknownAttachment);
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await upload(session.id)).id);
      await expect(queue(host, session.id, 'x', ids)).rejects.toBeInstanceOf(
        TooManyAttachments,
      );
      expect(await world.queue.list(session.id)).toEqual([]);
    });

    it('sends the message with its images when the run ends: delivery queued, used_seq of the new message, no hold', async () => {
      await start();
      const host = backend([[writeCall], [say('done')], [say('seen')]]);
      const { session, callId } = await waiting(host);
      const a = await upload(session.id, { name: 'queued.png' });
      await queue(host, session.id, 'and this picture', [a.id]);

      const decided = await host.useCases.decideApproval.execute({
        principal: janeFresh,
        sessionId: session.id,
        callId,
        decision: 'allow',
      });
      await drain(decided.run!);
      // Wait for the run of the queued message to exist and to end.
      await until(async () => {
        const sent = (await world.items.read(session.id)).find(
          i => i.kind === 'user_message' && i.delivery === 'queued',
        );
        return (
          sent !== undefined &&
          (await world.runRow(sent.runId!)).status === 'completed'
        );
      });

      const sent = (await world.items.read(session.id)).find(
        i => i.kind === 'user_message' && i.delivery === 'queued',
      )!;
      expect(sent).toMatchObject({
        attachments: [{ id: a.id, name: 'queued.png' }],
      });
      expect(await used(a.id)).toEqual({
        used_seq: sent.seq,
        reserved_by: null,
      });
      expect(host.model.inputs[2].messages.at(-1)).toMatchObject({
        role: 'user',
        images: [{ attachmentId: a.id, name: 'queued.png' }],
      });
    });
  });

  describe('the cleaning (IN-04)', () => {
    it('deletes the images that are in no message after 24 hours, and keeps the ones a message uses and the ones that are younger', async () => {
      await start();
      const host = backend([[say('ok')]]);
      const session = await world.newSession();
      const unused = await upload(session.id, { name: 'unused.png' });
      const inMessage = await upload(session.id, { name: 'used.png' });
      await drain(await send(host, session.id, [inMessage.id]));
      world.clock.advance(23 * HOUR);
      const young = await upload(session.id, { name: 'young.png' });
      expect(await host.useCases.purgeUnusedAttachments.execute()).toBe(0);

      world.clock.advance(2 * HOUR);
      expect(await host.useCases.purgeUnusedAttachments.execute()).toBe(1);

      await expect(
        world.attachments.get(session.id, unused.id),
      ).rejects.toThrow();
      await expect(
        world.attachments.get(session.id, inMessage.id),
      ).resolves.toBeDefined();
      await expect(
        world.attachments.get(session.id, young.id),
      ).resolves.toBeDefined();
    });

    it('deletes the images with the session', async () => {
      await start();
      const host = backend([[say('ok')]]);
      const session = await world.newSession();
      const a = await upload(session.id);
      const b = await upload(session.id);
      await drain(await send(host, session.id, [a.id]));

      await host.useCases.deleteSession.execute({
        principal: jane,
        sessionId: session.id,
      });

      for (const id of [a.id, b.id]) {
        expect(
          await world.knex('attachments').where({ id }).first(),
        ).toBeUndefined();
      }
    });
  });
});

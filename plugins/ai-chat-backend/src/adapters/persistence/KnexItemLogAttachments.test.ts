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

import type { AttachmentRef } from '@kwkevinchan/ai-chat-harness';
import { IMAGES, pngOfSize } from '../../__testUtils__/images';
import { TooManyImageBytes, UnknownAttachment } from '../../domain';
import { NEW_SESSION, createPersistence } from './__testUtils__';

type P = Awaited<ReturnType<typeof createPersistence>>;

const refOf = (meta: {
  id: string;
  mediaType: string;
  name: string;
  size: number;
}): AttachmentRef => ({
  id: meta.id,
  mediaType: meta.mediaType,
  name: meta.name,
  size: meta.size,
});

describe('KnexItemLog: the images of a message', () => {
  let p: P;
  let sessionId: string;

  async function upload(
    session = sessionId,
    bytes: Buffer = IMAGES['image/png'],
    name = 'shot.png',
  ) {
    return refOf(
      await p.attachments.put({
        sessionId: session,
        ownerRef: 'user:default/jane',
        mediaType: 'image/png',
        name,
        bytes,
        maxPending: 100,
      }),
    );
  }

  const row = (id: string) =>
    p.knex('attachments').where({ id }).first('used_seq', 'reserved_by');

  afterEach(async () => {
    await p.cleanup();
  });

  describe('the mark (IN-03)', () => {
    beforeEach(async () => {
      p = await createPersistence();
      sessionId = (await p.sessions.create(NEW_SESSION)).id;
    });

    it('sets used_seq to the seq of the message that is written, for a message that starts a run', async () => {
      const a = await upload();
      const b = await upload();
      const run = await p.runs.start(sessionId);
      const [item] = await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'look', attachments: [a, b] }],
        run.fence,
      );
      expect(item).toMatchObject({ seq: 1, attachments: [a, b] });
      expect(await row(a.id)).toEqual({ used_seq: 1, reserved_by: null });
      expect(await row(b.id)).toEqual({ used_seq: 1, reserved_by: null });
    });

    it('sets used_seq for an inserted message too', async () => {
      const a = await upload();
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go' }],
        run.fence,
      );
      const [inserted] = await p.items.append(
        sessionId,
        [
          {
            kind: 'user_message',
            text: 'and this',
            delivery: 'inserted',
            attachments: [a],
          },
        ],
        { runId: run.id, leaseOwner: '' },
      );
      expect(await row(a.id)).toEqual({
        used_seq: inserted.seq,
        reserved_by: null,
      });
    });

    it('keeps the seq of the first message when a later one uses the image again (send again)', async () => {
      const a = await upload();
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'first', attachments: [a] }],
        run.fence,
      );
      await p.runs.transition(run.id, 'completed');
      const second = await p.runs.start(sessionId);
      const [again] = await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'again', attachments: [a] }],
        second.fence,
      );
      expect(again.seq).toBe(2);
      expect((await row(a.id))?.used_seq).toBe(1);
    });

    it('marks nothing and writes nothing when one image is not in the session (UnknownAttachment)', async () => {
      const other = (await p.sessions.create(NEW_SESSION)).id;
      const mine = await upload();
      const foreign = await upload(other);
      const run = await p.runs.start(sessionId);
      await expect(
        p.items.append(
          sessionId,
          [{ kind: 'user_message', text: 'x', attachments: [mine, foreign] }],
          run.fence,
        ),
      ).rejects.toBeInstanceOf(UnknownAttachment);
      expect(await row(mine.id)).toEqual({ used_seq: null, reserved_by: null });
      expect(await row(foreign.id)).toEqual({
        used_seq: null,
        reserved_by: null,
      });
      expect(await p.items.read(sessionId)).toEqual([]);
      // The seq was not used up either.
      const [next] = await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'ok' }],
        run.fence,
      );
      expect(next.seq).toBe(1);
    });

    it('marks nothing when the write fails after the images were read (a repeated key)', async () => {
      const a = await upload();
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go' }],
        run.fence,
      );
      // The second draft repeats a key, so the whole batch is refused.
      await expect(
        p.items.append(
          sessionId,
          [
            { kind: 'user_message', text: 'x', attachments: [a] },
            {
              kind: 'approval',
              callId: 'c1',
              decision: 'allow',
              decidedBy: 'u',
            },
            {
              kind: 'approval',
              callId: 'c1',
              decision: 'allow',
              decidedBy: 'u',
            },
          ],
          run.fence,
        ),
      ).rejects.toThrow();
      expect(await row(a.id)).toEqual({ used_seq: null, reserved_by: null });
    });
  });

  describe('the bytes of the run (IN-06)', () => {
    beforeEach(async () => {
      p = await createPersistence({ maxImageBytesPerInput: 1000 });
      sessionId = (await p.sessions.create(NEW_SESSION)).id;
    });

    const insert = (
      runId: string,
      text: string,
      ...attachments: AttachmentRef[]
    ) =>
      p.items.append(
        sessionId,
        [{ kind: 'user_message', text, delivery: 'inserted', attachments }],
        { runId, leaseOwner: '' },
      );

    it('refuses an inserted message that takes the images of the run over the limit, and writes nothing', async () => {
      const first = await upload(sessionId, pngOfSize(600), 'first.png');
      const second = await upload(sessionId, pngOfSize(500), 'second.png');
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go', attachments: [first] }],
        run.fence,
      );

      await expect(insert(run.id, 'more', second)).rejects.toBeInstanceOf(
        TooManyImageBytes,
      );

      expect((await p.items.read(sessionId)).map(i => i.seq)).toEqual([1]);
      expect(await row(second.id)).toEqual({
        used_seq: null,
        reserved_by: null,
      });
    });

    it('takes an inserted message that brings the total exactly to the limit', async () => {
      const first = await upload(sessionId, pngOfSize(600), 'first.png');
      const second = await upload(sessionId, pngOfSize(400), 'second.png');
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go', attachments: [first] }],
        run.fence,
      );
      await expect(insert(run.id, 'more', second)).resolves.toHaveLength(1);
    });

    it('counts the images of every user message of the run, the inserted ones too', async () => {
      const a = await upload(sessionId, pngOfSize(400));
      const b = await upload(sessionId, pngOfSize(400));
      const c = await upload(sessionId, pngOfSize(400));
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go', attachments: [a] }],
        run.fence,
      );
      await insert(run.id, 'two', b);
      await expect(insert(run.id, 'three', c)).rejects.toBeInstanceOf(
        TooManyImageBytes,
      );
    });

    it('does not count the images of an earlier run', async () => {
      const a = await upload(sessionId, pngOfSize(900));
      const b = await upload(sessionId, pngOfSize(900));
      const first = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go', attachments: [a] }],
        first.fence,
      );
      await p.runs.transition(first.id, 'completed');
      const second = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'again' }],
        second.fence,
      );
      await expect(insert(second.id, 'more', b)).resolves.toHaveLength(1);
    });

    it('lets in only what fits when two inserts with images arrive at the same time', async () => {
      const a = await upload(sessionId, pngOfSize(600));
      const b = await upload(sessionId, pngOfSize(600));
      const run = await p.runs.start(sessionId);
      await p.items.append(
        sessionId,
        [{ kind: 'user_message', text: 'go' }],
        run.fence,
      );
      const results = await Promise.allSettled([
        insert(run.id, 'a', a),
        insert(run.id, 'b', b),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.filter(
          r => r.status === 'rejected' && r.reason instanceof TooManyImageBytes,
        ),
      ).toHaveLength(1);
    });
  });
});

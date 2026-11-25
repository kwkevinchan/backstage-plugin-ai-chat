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

import type { AttachmentRef, Item, ItemBody } from './item';
import {
  buildModelInput,
  buildSummaryInput,
  planSummary,
  type ContextBudget,
  type ModelMessage,
} from './modelInput';
import { agent, agentSays, budget, log, tool, user } from './fixtures';

const ref = (id: string, size = 1000, name = `${id}.png`): AttachmentRef => ({
  id,
  mediaType: 'image/png',
  name,
  size,
});

const withImages = (
  text: string,
  ...attachments: AttachmentRef[]
): ItemBody => ({
  kind: 'user_message',
  text,
  attachments,
});

const insertedWithImages = (
  text: string,
  ...attachments: AttachmentRef[]
): ItemBody => ({
  kind: 'user_message',
  text,
  delivery: 'inserted',
  attachments,
});

function build(
  bodies: ItemBody[],
  options: { images?: boolean; budget?: Partial<ContextBudget> } = {},
) {
  return buildModelInput(
    log(...bodies) as readonly Item[],
    agent,
    { context: [], tools: [tool()], images: options.images ?? true },
    // One recent step: the older messages are old enough to be shortened.
    { ...budget, keepRecentSteps: 1, ...options.budget },
  );
}

const userMessages = (messages: ModelMessage[]) =>
  messages.flatMap(message => (message.role === 'user' ? [message] : []));

describe('buildModelInput: images (IN-05, IN-06, IN-07)', () => {
  it('gives a user message its images, without bytes, in the order given', () => {
    const { messages } = build([
      withImages('look', ref('a'), ref('b', 2000, 'second.png')),
    ]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: 'look',
        images: [
          { attachmentId: 'a', mediaType: 'image/png', name: 'a.png' },
          { attachmentId: 'b', mediaType: 'image/png', name: 'second.png' },
        ],
      },
    ]);
  });

  it('gives a message that has images and no text only its images', () => {
    const { messages } = build([withImages('', ref('a'))]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: '',
        images: [{ attachmentId: 'a', mediaType: 'image/png', name: 'a.png' }],
      },
    ]);
  });

  it('gives a message with no image no images field', () => {
    const { messages } = build([user('plain'), withImages('empty')]);

    expect(messages).toEqual([
      { role: 'user', content: 'plain' },
      { role: 'user', content: 'empty' },
    ]);
  });

  it('sends no image to a model that cannot read them, and says so for each', () => {
    const { messages } = build(
      [withImages('look', ref('a'), ref('b', 10, 'b.jpg'))],
      { images: false },
    );

    expect(messages).toEqual([
      {
        role: 'user',
        content:
          'look\n[image: a.png, not sent: the model cannot read images]\n[image: b.jpg, not sent: the model cannot read images]',
      },
    ]);
  });

  it('treats an input with no `images` flag as a model that cannot read them', () => {
    const items = log(withImages('look', ref('a')));
    const { messages } = buildModelInput(
      items,
      agent,
      { context: [], tools: [] },
      budget,
    );

    expect(JSON.stringify(messages)).not.toContain('attachmentId');
    expect(messages[0]).toMatchObject({
      content: expect.stringContaining('not sent'),
    });
  });

  it('counts the images of the messages of the run as they are, even when they are inserted', () => {
    const { messages } = build([
      withImages('first', ref('a')),
      insertedWithImages('more', ref('b')),
      agentSays('ok', 0),
    ]);

    const images = userMessages(messages).map(m => m.images?.length);
    expect(images).toEqual([1, 1]);
  });

  describe('the token budget', () => {
    // Four user messages with one image each, then the run's own message.
    const history = (): ItemBody[] => [
      withImages('one', ref('a')),
      agentSays('r1'),
      withImages('two', ref('b')),
      agentSays('r2'),
      withImages('three', ref('c')),
      agentSays('r3'),
      withImages('current', ref('d')),
    ];

    it('counts each image as `tokensPerImage` and leaves out the oldest images first', () => {
      const { messages } = build(history(), {
        budget: { tokenBudget: 2 * 1000 + 300, tokensPerImage: 1000 },
      });

      const users = userMessages(messages);
      const byText = (text: string) =>
        users.find(m => m.content.startsWith(text));
      // Room for two images: the run's own message keeps its image, and the
      // newest older message keeps its too.
      expect(byText('current')?.images).toHaveLength(1);
      expect(byText('one')?.images).toBeUndefined();
      expect(byText('one')?.content).toBe('one\n[image: a.png, left out]');
      expect(byText('two')?.content).toBe('two\n[image: b.png, left out]');
    });

    it('never changes the images of the messages of the run, however small the budget', () => {
      const { messages } = build(
        [
          withImages('first', ref('a'), ref('b')),
          insertedWithImages('more', ref('c')),
          agentSays('ok', 0),
        ],
        { budget: { tokenBudget: 10, tokensPerImage: 1000 } },
      );

      const users = userMessages(messages);
      expect(users.map(m => m.images?.length)).toEqual([2, 1]);
      expect(JSON.stringify(users)).not.toContain('left out');
    });

    it('never changes the images of a message inserted into the run that lies between the first message and the newest steps', () => {
      const { messages } = build(
        [
          withImages('first', ref('a')),
          agentSays('r1', 1),
          insertedWithImages('more', ref('b')),
          agentSays('r2', 3),
          agentSays('r3', 3),
          agentSays('r4', 3),
        ],
        {
          budget: {
            tokenBudget: 10,
            tokensPerImage: 1000,
            maxImageBytesPerInput: 1,
          },
        },
      );

      const users = userMessages(messages);
      // The other user messages are notices that steps were left out.
      expect(users.filter(m => m.images).map(m => m.images?.length)).toEqual([
        1, 1,
      ]);
      expect(JSON.stringify(users)).not.toContain('[image:');
    });

    it('leaves the images in when they fit the budget', () => {
      const { messages } = build(history(), {
        budget: { tokenBudget: 24000, tokensPerImage: 1000 },
      });

      expect(userMessages(messages).map(m => m.images?.length)).toEqual([
        1, 1, 1, 1,
      ]);
    });

    it('uses 1600 tokens for an image when the budget gives no size', () => {
      const bodies = [
        withImages('one', ref('a')),
        agentSays('r1'),
        user('two'),
        agentSays('r2'),
        user('current'),
      ];

      const fits = build(bodies, { budget: { tokenBudget: 1900 } });
      const over = build(bodies, { budget: { tokenBudget: 1500 } });

      expect(userMessages(fits.messages)[0].images).toHaveLength(1);
      expect(userMessages(over.messages)[0].images).toBeUndefined();
    });

    it('leaves the images out before it leaves an old step out', () => {
      const { messages } = build(history(), {
        budget: { tokenBudget: 2 * 1000 + 400, tokensPerImage: 1000 },
      });

      const texts = messages.map(m => m.content).join('|');
      expect(texts).toContain('r1');
      expect(texts).toContain('r2');
      expect(texts).toContain('[image: a.png, left out]');
      expect(texts).toContain('[image: b.png, left out]');
      expect(texts).not.toContain('left out.');
    });
  });

  describe('the byte limit', () => {
    it('leaves out the images of old messages, oldest first, when the bytes are over, though the tokens fit', () => {
      const { messages } = build(
        [
          withImages('one', ref('a', 600)),
          agentSays('r1'),
          withImages('two', ref('b', 600)),
          agentSays('r2'),
          withImages('current', ref('c', 600)),
        ],
        { budget: { maxImageBytesPerInput: 1300 } },
      );

      const users = userMessages(messages);
      expect(users[0].content).toBe('one\n[image: a.png, left out]');
      expect(users[0].images).toBeUndefined();
      expect(users[1].images).toHaveLength(1);
      expect(users[2].images).toHaveLength(1);
    });

    describe('with the default of six recent steps', () => {
      const MB = 1024 * 1024;
      const budget6 = { keepRecentSteps: 6, maxImageBytesPerInput: 20 * MB };
      const four = (prefix: string) =>
        [1, 2, 3, 4].map(n => ref(`${prefix}${n}`, 5 * MB));
      const totalBytes = (messages: ModelMessage[], all: AttachmentRef[]) =>
        messages
          .flatMap(m => (m.role === 'user' ? m.images ?? [] : []))
          .reduce(
            (sum, image) =>
              sum + all.find(r => r.id === image.attachmentId)!.size,
            0,
          );

      it('leaves out the images of the message before the only earlier answer: 4 images of 5 MB, an answer, 4 images of 5 MB', () => {
        const older = four('o');
        const current = four('c');
        const { messages } = build(
          [
            withImages('earlier', ...older),
            agentSays('answer'),
            withImages('now', ...current),
          ],
          { budget: budget6 },
        );

        const users = userMessages(messages);
        expect(users[0].images).toBeUndefined();
        expect(users[0].content).toContain('[image: o1.png, left out]');
        expect(users[1].images).toHaveLength(4);
        expect(
          totalBytes(messages, [...older, ...current]),
        ).toBeLessThanOrEqual(20 * MB);
      });

      it('does it when every message is among the recent steps, and leaves out only as many as it must', () => {
        const a = four('a');
        const b = [ref('b1', 5 * MB), ref('b2', 5 * MB)];
        const current = four('c');
        const { messages } = build(
          [
            withImages('one', ...a),
            agentSays('r1'),
            withImages('two', ...b),
            agentSays('r2'),
            withImages('now', ...current),
          ],
          { budget: budget6 },
        );

        const users = userMessages(messages);
        // 4 + 2 + 4 images of 5 MB are 50 MB: the oldest message goes first,
        // then the next one is within the limit with the run's 20 MB.
        expect(users[0].images).toBeUndefined();
        expect(users[1].images).toBeUndefined();
        expect(users[2].images).toHaveLength(4);
        expect(
          totalBytes(messages, [...a, ...b, ...current]),
        ).toBeLessThanOrEqual(20 * MB);
      });

      it('stops when the limit is met: a younger message keeps its images', () => {
        const a = four('a');
        const b = [ref('b1', 5 * MB)];
        const c = [ref('c1', 5 * MB), ref('c2', 5 * MB)];
        const { messages } = build(
          [
            withImages('one', ...a),
            agentSays('r1'),
            withImages('two', ...b),
            agentSays('r2'),
            withImages('now', ...c),
          ],
          { budget: budget6 },
        );
        const users = userMessages(messages);
        // 20 + 5 + 10 MB: leaving out the first message is enough.
        expect(users[0].images).toBeUndefined();
        expect(users[1].images).toHaveLength(1);
        expect(users[2].images).toHaveLength(2);
      });
    });

    it('does not touch the images of the run, even when they alone are over the limit', () => {
      const { messages } = build(
        [
          withImages('old', ref('a', 500)),
          agentSays('r1'),
          withImages('current', ref('b', 800), ref('c', 800)),
          insertedWithImages('more', ref('d', 800)),
          agentSays('ok', 0),
        ],
        { budget: { maxImageBytesPerInput: 1000 } },
      );

      const users = userMessages(messages);
      expect(users[0].images).toBeUndefined();
      expect(users[1].images).toHaveLength(2);
      expect(users[2].images).toHaveLength(1);
    });

    it('leaves out the images of the inserted messages of an older run', () => {
      const { messages } = build(
        [
          user('first'),
          agentSays('r1', 1),
          insertedWithImages('more', ref('a', 900)),
          agentSays('r2', 3),
          user('next'),
          agentSays('r3'),
          withImages('current', ref('b', 900)),
        ],
        { budget: { maxImageBytesPerInput: 1000 } },
      );

      const users = userMessages(messages);
      expect(users[1].content).toBe('more\n[image: a.png, left out]');
      expect(users[3].images).toHaveLength(1);
    });

    it('does not count the images of a model that cannot read them', () => {
      const { messages } = build(
        [
          withImages('one', ref('a', 900)),
          agentSays('r1'),
          withImages('current', ref('b', 900)),
        ],
        { images: false, budget: { maxImageBytesPerInput: 100 } },
      );

      expect(JSON.stringify(messages)).not.toContain('left out');
      expect(JSON.stringify(messages)).toContain('not sent');
    });
  });

  describe('the summary (IN-06)', () => {
    it('writes an image of a covered message as one `[image: <name>]` line and sends no image', () => {
      const bodies: ItemBody[] = [
        withImages('old question', ref('a', 1000, 'diagram.png')),
        agentSays('old answer'),
        user('current'),
      ];
      const items = log(...bodies);
      const plan = {
        coversUpToSeq: 2,
        items: items.slice(0, 2),
      };

      const input = buildSummaryInput(plan, budget);

      expect(input.messages).toHaveLength(1);
      expect(input.messages[0]).toEqual({
        role: 'user',
        content: expect.stringContaining(
          'User: old question\n[image: diagram.png]',
        ),
      });
      expect(JSON.stringify(input)).not.toContain('attachmentId');
      expect(JSON.stringify(input)).not.toContain('left out');
    });

    it('counts the images when it decides whether a summary is needed', () => {
      const bodies: ItemBody[] = [
        withImages('old question', ref('a')),
        agentSays('old answer'),
        agentSays('another old answer'),
        user('current'),
      ];
      const small = { tokenBudget: 3000, keepRecentSteps: 1 };
      const items = log(...bodies);
      const extra = { context: [], tools: [], images: true };

      // The image alone is over the budget until it is left out; leaving it
      // out is enough, so no summary is needed.
      expect(
        planSummary(items, agent, extra, { ...small, tokensPerImage: 5000 }),
      ).toBeUndefined();
    });
  });
});

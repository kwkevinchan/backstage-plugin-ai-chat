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

import type { Item } from '@kwkevinchan/ai-chat-harness';
import {
  GENERATED_TITLE_MAX_CHARS,
  TITLE_SOURCE_MAX_CHARS,
  conversationForTitle,
  searchLikePattern,
  shouldAutoTitle,
  titleFromModelAnswer,
} from './sessionList';

describe('searchLikePattern', () => {
  it('trims the query, keeps its letters, and escapes %, _ and !', () => {
    expect(searchLikePattern('  Build  ')).toBe('%Build%');
    expect(searchLikePattern('100%_done!')).toBe('%100!%!_done!!%');
  });
});

describe('shouldAutoTitle', () => {
  it.each([
    [{ hasTitle: false, normalEnd: true, earlierNormalEnd: false }, true],
    [{ hasTitle: true, normalEnd: true, earlierNormalEnd: false }, false],
    [{ hasTitle: false, normalEnd: false, earlierNormalEnd: false }, false],
    [{ hasTitle: false, normalEnd: true, earlierNormalEnd: true }, false],
  ])('%j -> %s', (input, expected) => {
    expect(shouldAutoTitle(input)).toBe(expected);
  });
});

describe('titleFromModelAnswer', () => {
  it('keeps the first line, drops one pair of quotes, and clips the length', () => {
    expect(titleFromModelAnswer('  Build is red  \nmore')).toBe('Build is red');
    expect(titleFromModelAnswer('"Build is red"')).toBe('Build is red');
    expect(titleFromModelAnswer("'Build is red'")).toBe('Build is red');
    expect(titleFromModelAnswer('「為什麼建置失敗」')).toBe('為什麼建置失敗');
    expect(titleFromModelAnswer('“Build is red”')).toBe('Build is red');
    expect(titleFromModelAnswer(`  ${'a'.repeat(100)}`)).toHaveLength(
      GENERATED_TITLE_MAX_CHARS,
    );
  });

  it('returns nothing for an empty answer', () => {
    expect(titleFromModelAnswer('')).toBeUndefined();
    expect(titleFromModelAnswer('  \n  ')).toBeUndefined();
    expect(titleFromModelAnswer('""')).toBeUndefined();
    expect(titleFromModelAnswer('\u0000')).toBeUndefined();
  });
});

describe('conversationForTitle', () => {
  const item = (over: Partial<Item> & Pick<Item, 'kind'>): Item =>
    ({
      sessionId: 's1',
      seq: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      runId: 'r1',
      text: '',
      ...over,
    } as Item);

  it('uses the first user message and the assistant text of that run only', () => {
    const text = conversationForTitle(
      [
        item({ kind: 'user_message', text: 'Why is the build red?', seq: 1 }),
        item({
          kind: 'tool_result',
          seq: 2,
          text: 'ignore this',
        } as Partial<Item> & Pick<Item, 'kind'>),
        item({ kind: 'agent_message', text: 'The tests failed.', seq: 3 }),
        item({
          kind: 'user_message',
          text: 'a later insert',
          seq: 4,
        }),
        item({
          kind: 'user_message',
          text: 'other run',
          seq: 5,
          runId: 'r2',
        }),
      ],
      'r1',
    );
    expect(text).toBe(
      'User: Why is the build red?\n\nAssistant: The tests failed.',
    );
  });

  it('returns nothing when the run has no text, and clips a long message', () => {
    expect(
      conversationForTitle([item({ kind: 'user_message', text: '   ' })], 'r1'),
    ).toBeUndefined();
    const text = conversationForTitle(
      [item({ kind: 'user_message', text: 'x'.repeat(800) })],
      'r1',
    );
    expect(text).toBe(
      `User: ${'x'.repeat(TITLE_SOURCE_MAX_CHARS)}\n\nAssistant: `,
    );
  });
});

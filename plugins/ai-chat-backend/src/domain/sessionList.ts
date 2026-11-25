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
/**
 * How long a generated title may be, in characters. A title a person sets may
 * be longer (the API allows 200); a generated one has to fit the list.
 */
export const GENERATED_TITLE_MAX_CHARS = 80;

/** How much of one message is given to the model that writes the title. */
export const TITLE_SOURCE_MAX_CHARS = 500;

/** The query with the spaces at the ends removed. Empty after that means no filter. */
export function normalizeSearchQuery(query: string | undefined): string {
  return (query ?? '').trim();
}

/**
 * The `LIKE` pattern of a query, with `!` as the escape character, so `%` and
 * `_` in the query match themselves. The caller matches
 * `lower(title) like lower(pattern)`, so SQLite and PostgreSQL apply the same
 * function on both sides. Case folding then follows each database's `lower()`.
 */
export function searchLikePattern(query: string): string {
  const q = normalizeSearchQuery(query);
  return `%${q.replace(/[!%_]/g, char => `!${char}`)}%`;
}

/**
 * Whether this end of a run should produce a title (SE-04). Only the first
 * run that ends the normal way, and only while the session has no title. A
 * title the user set is kept. A failed attempt is not tried again: a later
 * normal end sees `earlierNormalEnd`.
 */
export function shouldAutoTitle(input: {
  hasTitle: boolean;
  normalEnd: boolean;
  earlierNormalEnd: boolean;
}): boolean {
  return !input.hasTitle && input.normalEnd && !input.earlierNormalEnd;
}

/**
 * The title to store from the text the model returned, or nothing when the
 * answer has no usable line. The first line, with one pair of wrapping quotes
 * removed, and no longer than {@link GENERATED_TITLE_MAX_CHARS}.
 */
export function titleFromModelAnswer(raw: string): string | undefined {
  const line = raw
    .split('\u0000')
    .join('')
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(part => part.length > 0);
  if (line === undefined) return undefined;
  let text = line.replace(/\s+/g, ' ').trim();
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['「', '」'],
    ['“', '”'],
  ];
  for (const [open, close] of pairs) {
    if (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.length >= open.length + close.length
    ) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  }
  text = text.slice(0, GENERATED_TITLE_MAX_CHARS).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The text given to the model that writes the title: the first message of the
 * user in the run, and the text of the assistant, each clipped. Tool output
 * and images are left out. Nothing when the run has no text.
 */
export function conversationForTitle(
  items: readonly Item[],
  runId: string,
): string | undefined {
  let user = '';
  let sawUser = false;
  const assistant: string[] = [];
  for (const item of items) {
    if (item.runId !== runId) continue;
    if (item.kind === 'user_message' && !sawUser) {
      user = item.text;
      sawUser = true;
    } else if (item.kind === 'agent_message') {
      assistant.push(item.text);
    }
  }
  const userText = clip(user);
  const assistantText = clip(assistant.join('\n'));
  if (userText.length === 0 && assistantText.length === 0) return undefined;
  return `User: ${userText}\n\nAssistant: ${assistantText}`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_SOURCE_MAX_CHARS
    ? flat
    : flat.slice(0, TITLE_SOURCE_MAX_CHARS).trim();
}

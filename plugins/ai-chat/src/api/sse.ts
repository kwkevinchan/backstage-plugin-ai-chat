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

import type { ChatEvent } from '../common';

/**
 * Reads the events of a `text/event-stream` body. `chunks` are the pieces of
 * the body as text; an event ends with a blank line, and its `data:` lines
 * hold the event as JSON. A block that is no valid event is skipped.
 */
export async function* parseEventStream(
  chunks: AsyncIterable<string>,
): AsyncGenerator<ChatEvent> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    for (
      let end = buffer.search(/\r?\n\r?\n/);
      end >= 0;
      end = buffer.search(/\r?\n\r?\n/)
    ) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const event = parseBlock(block);
      if (event) yield event;
    }
  }
  const rest = parseBlock(buffer);
  if (rest) yield rest;
}

function parseBlock(block: string): ChatEvent | undefined {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  try {
    const value = JSON.parse(data);
    return typeof value?.type === 'string' ? (value as ChatEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** The text pieces of a fetch response body. */
export async function* bodyChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

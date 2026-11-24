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
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

/**
 * Reads the body of a response with the parser of the AI SDK, the one
 * `useChat` uses: every `data:` line must be a chunk of the protocol, and
 * the body must end with `[DONE]`. Returns the chunks the SDK parsed.
 */
export async function parseSse(body: string): Promise<UIMessageChunk[]> {
  expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  const reader = parseJsonEventStream({
    stream: new Response(body).body!,
    schema: uiMessageChunkSchema,
  }).getReader();
  const chunks: UIMessageChunk[] = [];
  const failures: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.success) chunks.push(value.value);
    else failures.push(value.error);
  }
  expect(failures).toEqual([]);
  return chunks;
}

/**
 * The message the SDK builds from the chunks (what `useChat` shows). With
 * `from`, the stream continues that message.
 */
export async function readMessage(
  chunks: UIMessageChunk[],
  from?: UIMessage,
): Promise<UIMessage> {
  let message: UIMessage | undefined = from;
  const errors: unknown[] = [];
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  for await (const next of readUIMessageStream({
    ...(from && { message: from }),
    stream,
    onError: error => errors.push(error),
  })) {
    message = next;
  }
  expect(errors).toEqual([]);
  return message!;
}

/** The chunks of the presenter, read back through the SDK's own parser. */
export async function throughSdk(chunks: object[]): Promise<UIMessageChunk[]> {
  const body = `${chunks
    .map(c => `data: ${JSON.stringify(c)}\n\n`)
    .join('')}data: [DONE]\n\n`;
  return parseSse(body);
}

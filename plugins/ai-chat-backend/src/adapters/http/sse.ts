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

import type { Response } from 'express';
import type { HostEvent } from '../../application';
import type { Logger } from '../../application/ports';
import type { UiMessageChunk } from './presenters/uiMessageChunk';
import type { UiMessageStreamPresenter } from './presenters/uiMessageStream';

const STREAM_FAILED_TEXT = 'The run stopped.';

export const DEFAULT_KEEP_ALIVE_MS = 15_000;

/**
 * Writes one line of the stream and pushes it out: a compression layer of the
 * backend (the root router of Backstage has one) holds the data back until it
 * is flushed.
 */
function writeRaw(res: Response, text: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(text);
  (res as unknown as { flush?: () => void }).flush?.();
}

function write(res: Response, chunk: UiMessageChunk | '[DONE]'): void {
  writeRaw(
    res,
    `data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`,
  );
}

/**
 * Answers with a UI message stream of the AI SDK: the chunks of `head`, then
 * the chunks the presenter makes of the events, then `[DONE]`. The response
 * ends when the events end. A client that goes away stops the reading and the
 * subscription; the run goes on (A-06).
 *
 * The headers are the ones of the SDK, except `connection`, which HTTP/2
 * does not allow, and `cache-control` also says `no-transform`, so a proxy
 * does not compress or buffer the stream. Every `keepAliveMs` without a chunk
 * a comment line goes out, so an idle connection (a long model call or tool)
 * is not closed by a proxy. A comment line is not an event.
 */
export async function sendUiMessageStream(
  res: Response,
  stream: {
    events: AsyncIterable<HostEvent>;
    presenter: UiMessageStreamPresenter;
    head?: UiMessageChunk[];
  },
  logger: Logger,
  keepAliveMs: number = DEFAULT_KEEP_ALIVE_MS,
): Promise<void> {
  const iterator = stream.events[Symbol.asyncIterator]();
  let gone = false;
  res.on('close', () => {
    if (res.writableEnded) return;
    gone = true;
    void iterator.return?.();
  });
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Vercel-AI-UI-Message-Stream', 'v1');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const keepAlive = setInterval(
    () => writeRaw(res, ': keep-alive\n\n'),
    keepAliveMs,
  );

  try {
    for (const chunk of stream.head ?? []) write(res, chunk);
    while (!gone) {
      const next = await iterator.next();
      if (next.done) break;
      for (const chunk of stream.presenter.present(next.value)) {
        write(res, chunk);
      }
    }
    if (!gone) {
      for (const chunk of stream.presenter.close()) write(res, chunk);
      write(res, '[DONE]');
    }
  } catch (error) {
    // The text of the error stays in the log; the client gets a fixed text.
    logger.error('A response stream failed after it started', {
      error: error instanceof Error ? error.message : String(error),
    });
    write(res, { type: 'error', errorText: STREAM_FAILED_TEXT });
    write(res, '[DONE]');
    void iterator.return?.();
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
}

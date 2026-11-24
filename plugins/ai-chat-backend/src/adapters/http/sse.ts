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

import type { HarnessEvent } from '@kwkevinchan/ai-chat-harness';
import type { Response } from 'express';
import type { Logger } from '../../application/ports';
import type { UiMessageChunk } from './presenters/uiMessageChunk';
import type { UiMessageStreamPresenter } from './presenters/uiMessageStream';

const STREAM_FAILED_TEXT = 'The run stopped.';

function write(res: Response, chunk: UiMessageChunk | '[DONE]'): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`);
}

/**
 * Answers with a UI message stream of the AI SDK: the chunks of `head`, then
 * the chunks the presenter makes of the events, then `[DONE]`. The response
 * ends when the events end. A client that goes away stops the reading and the
 * subscription; the run goes on (A-06).
 *
 * The headers are the ones of the SDK, except `connection`, which HTTP/2
 * does not allow.
 */
export async function sendUiMessageStream(
  res: Response,
  stream: {
    events: AsyncIterable<HarnessEvent>;
    presenter: UiMessageStreamPresenter;
    head?: UiMessageChunk[];
  },
  logger: Logger,
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
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Vercel-AI-UI-Message-Stream', 'v1');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

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
    if (!res.writableEnded) res.end();
  }
}

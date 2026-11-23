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

import type { Request, Response } from 'express';
import type { ChatEvent } from '../common';
import type { ChatStream } from '../chat/ChatService';

/**
 * A `text/event-stream` response. The headers go out with the first event,
 * so that a request that is refused before anything happens still gets a
 * normal status code and error body.
 */
export class SseResponse {
  private started = false;
  private readonly controller = new AbortController();

  constructor(private readonly res: Response) {
    // The client closed the connection before the response ended.
    res.on('close', () => {
      if (!res.writableEnded) this.controller.abort();
    });
  }

  get hasStarted() {
    return this.started;
  }

  readonly stream: ChatStream = {
    signal: this.controller.signal,
    emit: (event: ChatEvent) => this.write(event),
  };

  private write(event: ChatEvent) {
    if (this.res.writableEnded || this.res.destroyed) return;
    if (!this.started) {
      this.started = true;
      this.res.status(200);
      this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      this.res.setHeader('Cache-Control', 'no-cache, no-transform');
      this.res.setHeader('Connection', 'keep-alive');
      // Tells a reverse proxy not to buffer the stream.
      this.res.setHeader('X-Accel-Buffering', 'no');
      this.res.flushHeaders();
    }
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** Ends the stream; an error after the first event becomes an `error` event. */
  finish(error?: unknown) {
    if (error !== undefined && this.started) {
      this.write({
        type: 'error',
        message: error instanceof Error ? error.message : 'The request failed',
      });
    }
    if (!this.res.writableEnded) this.res.end();
  }
}

export type { Request };

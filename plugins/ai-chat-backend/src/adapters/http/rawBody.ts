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

import type { IncomingMessage } from 'node:http';
import { AttachmentTooLarge } from '../../domain';

/**
 * Reads the body of a request into memory, at most `limit` bytes (IN-02).
 *
 * - A `Content-Length` over the limit is refused before a byte is read.
 * - Without one (`Transfer-Encoding: chunked`), or with a header that says
 *   less than what arrives, reading stops at the first chunk that takes the
 *   total over the limit. The bytes kept are never more than `limit`, plus
 *   the one chunk that crossed it, which is dropped.
 * - It throws `AttachmentTooLarge` at once and does not read the rest: the
 *   caller closes the connection (`Connection: close`), so the rest of an
 *   upload is not read off the socket either. `express.raw` does the same
 *   limit, but reads the whole body off the socket before it answers.
 */
export function readLimited(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new AttachmentTooLarge(limit));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    function stop() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    }
    function onData(chunk: Buffer) {
      size += chunk.length;
      if (size > limit) {
        stop();
        req.pause();
        reject(new AttachmentTooLarge(limit));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      stop();
      resolve(Buffer.concat(chunks, size));
    }
    function onError(error: Error) {
      stop();
      reject(error);
    }
    function onClose() {
      stop();
      reject(new Error('The request was closed before its body ended'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/** The media type of a `Content-Type` header: lower case, no parameters. */
export function mediaTypeOf(header: string | undefined): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

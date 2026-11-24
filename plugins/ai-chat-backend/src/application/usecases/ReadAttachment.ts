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

import { assertOwner, type AttachmentMeta, type Principal } from '../../domain';
import type { AttachmentStore, SessionRepository } from '../ports';

/** The owner reads an image of the session (IN-03, IN-08). */
export class ReadAttachment {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      attachments: AttachmentStore;
    },
  ) {}

  /**
   * Throws `NotSessionOwner` or `AttachmentNotFound` (a missing image, or
   * one of another session). With `ifNoneMatch` equal to the `ETag` of the
   * image, the bytes are not read and the answer is `notModified`. The check
   * of the owner and of the existence comes first, so a deleted image is
   * `AttachmentNotFound` whatever the client has cached.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    attachmentId: string;
    ifNoneMatch?: string;
  }): Promise<
    | { notModified: true; meta: AttachmentMeta }
    | { notModified: false; meta: AttachmentMeta; bytes: Uint8Array }
  > {
    const { sessions, attachments } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const [meta] = await attachments.describe(session.id, [input.attachmentId]);
    if (
      input.ifNoneMatch !== undefined &&
      etagMatches(input.ifNoneMatch, meta)
    ) {
      return { notModified: true, meta };
    }
    const read = await attachments.get(session.id, input.attachmentId);
    return { notModified: false, ...read };
  }
}

/** The `ETag` of an image: its hash, quoted. */
export function etagOf(meta: Pick<AttachmentMeta, 'sha256'>): string {
  return `"${meta.sha256}"`;
}

function etagMatches(header: string, meta: AttachmentMeta): boolean {
  const etag = etagOf(meta);
  return header
    .split(',')
    .map(value => value.trim().replace(/^W\//, ''))
    .some(value => value === '*' || value === etag);
}

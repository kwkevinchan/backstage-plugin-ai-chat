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

import type { Clock, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  AttachmentNotFound,
  type AttachmentMeta,
  type Principal,
} from '../../domain';
import type {
  AccessControl,
  AttachmentStore,
  SessionRepository,
  ShareRepository,
} from '../ports';
import { authorizeRead, shareeView } from '../sessionRead';

/**
 * The owner, or a sharee who sees a message with it, reads an image of the
 * session (IN-03, IN-08, IN-19).
 */
export class ReadAttachment {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      attachments: AttachmentStore;
      shares: ShareRepository;
      access: AccessControl;
      items: ItemLog;
      clock: Clock;
    },
  ) {}

  /**
   * Throws `NotSessionOwner` or `AttachmentNotFound` (a missing image, one
   * of another session, or one the sharee does not see). With `ifNoneMatch`
   * equal to the `ETag` of the image, the bytes are not read and the answer
   * is `notModified`. The check of the reader and of the existence comes
   * first, so a deleted image is
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
    const { attachments } = this.deps;
    const reader = await authorizeRead(
      this.deps,
      input.sessionId,
      input.principal,
    );
    const { session } = reader;
    if (!reader.isOwner) {
      // IN-19: an image is the sharee's to read when a message they see has
      // it, so its `used_seq` is within the share. Anything else is answered
      // like an image that does not exist.
      const { visible } = await shareeView(
        this.deps,
        session,
        input.principal,
        reader.shares,
      );
      const seen = visible.some(
        item =>
          item.kind === 'user_message' &&
          (item.attachments ?? []).some(ref => ref.id === input.attachmentId),
      );
      if (!seen) throw new AttachmentNotFound(input.attachmentId);
    }
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

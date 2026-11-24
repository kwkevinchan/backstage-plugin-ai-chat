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
  assertOwner,
  AttachmentTooLarge,
  checkImage,
  cleanAttachmentName,
  ImagesNotSupported,
  InvalidAttachment,
  isImageMediaType,
  UnsupportedAttachmentType,
  type AttachmentMeta,
  type Principal,
} from '../../domain';
import type { ImageSettings } from '../attachments';
import type { AttachmentStore, SessionRepository } from '../ports';

/** The user adds an image to a session (IN-01 to IN-04). */
export class UploadAttachment {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      attachments: AttachmentStore;
      images: ImageSettings;
    },
  ) {}

  /**
   * What the route checks before it reads a byte of the body: the caller owns
   * the session (`NotSessionOwner`), the model reads images
   * (`ImagesNotSupported`) and the type is one the chat takes
   * (`UnsupportedAttachmentType`). Returns the largest body to read.
   */
  async authorize(input: {
    principal: Principal;
    sessionId: string;
    mediaType: string;
  }): Promise<{ maxBytes: number }> {
    const { sessions, images } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    if (!images.enabled) throw new ImagesNotSupported();
    if (!isImageMediaType(input.mediaType)) {
      throw new UnsupportedAttachmentType(input.mediaType);
    }
    return { maxBytes: images.maxBytes };
  }

  /**
   * Stores the image. Throws `NotSessionOwner`, `ImagesNotSupported`,
   * `UnsupportedAttachmentType`, `AttachmentTooLarge`, `InvalidAttachment`
   * (empty, a header that is not the one of the type, a name with nothing
   * left) or `TooManyPendingAttachments`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    mediaType: string;
    name: string;
    bytes: Uint8Array;
  }): Promise<AttachmentMeta> {
    const { attachments, images } = this.deps;
    const { maxBytes } = await this.authorize(input);
    if (!isImageMediaType(input.mediaType)) {
      throw new UnsupportedAttachmentType(input.mediaType);
    }
    if (input.bytes.length > maxBytes) throw new AttachmentTooLarge(maxBytes);
    if (input.bytes.length === 0)
      throw new InvalidAttachment('The image is empty');
    const name = cleanAttachmentName(input.name);
    if (name === undefined) {
      throw new InvalidAttachment('The name of the image is empty');
    }
    if (!checkImage(input.mediaType, input.bytes)) {
      throw new InvalidAttachment(
        `The content is not ${input.mediaType}: the header does not match`,
      );
    }
    return attachments.put({
      sessionId: input.sessionId,
      ownerRef: input.principal.userRef,
      mediaType: input.mediaType,
      name,
      bytes: input.bytes,
      maxPending: images.maxPendingPerSession,
    });
  }
}

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

import type { AttachmentRef } from '@kwkevinchan/ai-chat-harness';
import {
  AttachmentNotFound,
  ImagesNotSupported,
  TooManyAttachments,
  UnknownAttachment,
  type AttachmentMeta,
  type ImageLimits,
} from '../domain';
import type { AttachmentStore } from './ports';

/**
 * What the use cases need to know about images: whether the model reads them
 * (`aiChat.llm.images`, IN-05) and the limits (`aiChat.input.images`).
 */
export type ImageSettings = ImageLimits & { enabled: boolean };

/** The reference to an image that goes into the message, with no session or hash. */
export function toAttachmentRef(meta: AttachmentMeta): AttachmentRef {
  return {
    id: meta.id,
    mediaType: meta.mediaType,
    name: meta.name,
    size: meta.size,
  };
}

/**
 * Checks the images a message names before anything is written: the model
 * reads images (`ImagesNotSupported`), there are at most `maxPerMessage`
 * (`TooManyAttachments`), and each one is in the session
 * (`UnknownAttachment`). The write checks the last point again, in its own
 * transaction. Returns the meta in the order of `ids`.
 */
export async function bindAttachments(
  deps: { attachments: AttachmentStore; images: ImageSettings },
  sessionId: string,
  ids: string[] | undefined,
): Promise<AttachmentMeta[]> {
  if (!ids || ids.length === 0) return [];
  const { attachments, images } = deps;
  if (!images.enabled) throw new ImagesNotSupported();
  if (ids.length > images.maxPerMessage) {
    throw new TooManyAttachments(images.maxPerMessage);
  }
  try {
    return await attachments.describe(sessionId, ids);
  } catch (error) {
    if (error instanceof AttachmentNotFound) {
      throw new UnknownAttachment(error.message.replace(/^.* attachment /, ''));
    }
    throw error;
  }
}

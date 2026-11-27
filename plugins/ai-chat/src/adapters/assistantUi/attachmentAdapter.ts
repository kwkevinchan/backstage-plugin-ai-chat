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

import type {
  AppendMessage,
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react';
import type { ChatAttachment } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { OutgoingMessage } from '../../domain/types';
import { describeError } from '../describeError';

/** What the screen checks before it uploads an image (from `GET /input-config`). */
export interface ImageLimits {
  mediaTypes: string[];
  maxPerMessage: number;
  maxBytes: number;
}

/** What the attachments of assistant-ui are made of. */
export interface AttachmentSource {
  limits: ImageLimits;
  /** Uploads one image to the session. */
  upload(file: File): Promise<ChatAttachment>;
  /** Deletes a pending uploaded image when removed from the draft. */
  remove?(attachmentId: string): Promise<void>;
  /** Called when `add` starts, before its checks. */
  onAdd?(): void;
}

/** The name of the data part that carries our attachment in an attachment of assistant-ui. */
export const ATTACHMENT_PART = 'chat-attachment';

export const WRONG_TYPE_TEXT =
  'Only PNG, JPEG, WebP and GIF images can be attached.';

function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  const kb = 1024;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb} MB`;
  if (bytes >= kb && bytes % kb === 0) return `${bytes / kb} KB`;
  return `${bytes} bytes`;
}

export const tooLargeText = (maxBytes: number) =>
  `This image is over the size limit of ${formatBytes(maxBytes)}.`;

export const tooManyText = (max: number) =>
  `A message can have at most ${max} ${max === 1 ? 'image' : 'images'}.`;

/** An attachment of a message as assistant-ui shows it; its content is our attachment, no URL. */
export function toCompleteAttachment(
  attachment: ChatAttachment,
): CompleteAttachment {
  return {
    id: attachment.id,
    type: 'image',
    name: attachment.name,
    contentType: attachment.mediaType,
    status: { type: 'complete' },
    content: [{ type: 'data', name: ATTACHMENT_PART, data: attachment }],
  };
}

/** Our attachment in an attachment of assistant-ui, when it has been uploaded. */
export function chatAttachmentOf(
  attachment: Pick<Attachment, 'content'>,
): ChatAttachment | undefined {
  for (const part of attachment.content ?? []) {
    if (part.type === 'data' && part.name === ATTACHMENT_PART) {
      return part.data as ChatAttachment;
    }
  }
  return undefined;
}

/** Our attachments of a sent message, in its order. */
export function chatAttachmentsOf(
  attachments: readonly Pick<Attachment, 'content'>[] | undefined,
): ChatAttachment[] {
  return (attachments ?? []).flatMap(attachment => {
    const chat = chatAttachmentOf(attachment);
    return chat ? [chat] : [];
  });
}

/** What a message of assistant-ui sends: its text, and our attachments. */
export function outgoingOf(message: AppendMessage): OutgoingMessage {
  const text = message.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
  const attachments = chatAttachmentsOf(message.attachments);
  return attachments.length > 0 ? { text, attachments } : { text };
}

/** A message with neither text nor images is not sent. */
export function isEmptyMessage(message: OutgoingMessage): boolean {
  return !message.text && !message.attachments?.length;
}

let nextId = 0;

/**
 * The attachments of assistant-ui on the uploads of the backend.
 *
 * - `add` checks the size and the count, and throws the reason without an
 *   upload. assistant-ui checks the type against `accept` before `add`.
 *   A good image is uploaded at once: the draft shows it uploading, then
 *   complete with our attachment, or failed with the reason.
 * - `send` is called only for an image whose upload failed. It throws the
 *   reason, and assistant-ui keeps the message in the box; the user removes
 *   the image or attaches it again.
 * - `remove`: called by `@assistant-ui/core` for incomplete (in-flight)
 *   attachments; records the id so `source.remove` runs once the upload
 *   finishes. Completed draft images invoke `source.remove` directly from
 *   `DraftImage`'s Remove button. Errors are ignored so removing from the
 *   draft never blocks; unused uploads are also purged by the backend after
 *   a day.
 *
 * The last state of a good image is `complete`, which the type of `add` does
 * not list. assistant-ui 0.15 takes it. A message with an image that is not
 * complete goes out as a submission, and assistant-ui shows a submission as a
 * message of the thread until a new user message arrives; an inserted or
 * queued message never arrives as one, so that copy would stay.
 *
 * `draftCount` is the number of images in the box. Images added together
 * (one drop, one choice of files) count each other before the box shows them.
 */
export function createAttachmentAdapter(
  source: AttachmentSource,
  draftCount: () => number,
): AttachmentAdapter {
  const { limits } = source;
  const failures = new Map<string, string>();
  const removed = new Set<string>();
  let starting = 0;

  async function* add({
    file,
  }: {
    file: File;
  }): AsyncGenerator<PendingAttachment, void> {
    source.onAdd?.();
    if (!limits.mediaTypes.includes(file.type)) {
      throw new Error(WRONG_TYPE_TEXT);
    }
    if (file.size > limits.maxBytes) {
      throw new Error(tooLargeText(limits.maxBytes));
    }
    if (draftCount() + starting >= limits.maxPerMessage) {
      throw new Error(tooManyText(limits.maxPerMessage));
    }
    nextId += 1;
    const base = {
      id: `draft-image-${nextId}`,
      type: 'image',
      name: file.name || 'image',
      contentType: file.type,
      file,
    } as const;
    // Counted until the box shows it, which happens before the generator
    // resumes after its first yield.
    starting += 1;
    let counted = true;
    const shown = () => {
      if (counted) starting -= 1;
      counted = false;
    };
    try {
      yield {
        ...base,
        status: { type: 'running', reason: 'uploading', progress: 0 },
      };
      shown();
      try {
        const attachment = await source.upload(file);
        if (removed.has(base.id)) {
          if (source.remove) {
            void source.remove(attachment.id).catch(() => {});
          }
          return;
        }
        yield {
          ...toCompleteAttachment(attachment),
          id: base.id,
          file,
        } as unknown as PendingAttachment;
      } catch (error) {
        if (removed.has(base.id)) return;
        const message = describeError(error);
        failures.set(base.id, message);
        yield {
          ...base,
          status: { type: 'incomplete', reason: 'error', message },
        };
      }
    } finally {
      shown();
    }
  }

  return {
    accept: limits.mediaTypes.join(','),
    add,
    async send(attachment) {
      throw new Error(
        failures.get(attachment.id) ?? `${attachment.name} is not uploaded.`,
      );
    },
    async remove(attachment) {
      removed.add(attachment.id);
      failures.delete(attachment.id);
      const uploaded = chatAttachmentOf(attachment);
      if (uploaded && source.remove) {
        try {
          await source.remove(uploaded.id);
        } catch {
          // Removing from the draft never blocks on backend cleanup.
        }
      }
    },
  };
}

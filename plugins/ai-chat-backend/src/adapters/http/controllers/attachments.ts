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
  MAX_REFERENCE_TEXT_LENGTH,
  type ChatInputConfig,
  type ChatUploadedAttachment,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { Request, Response } from 'express';
import type {
  DeleteAttachment,
  ReadAttachment,
  UploadAttachment,
} from '../../../application';
import { etagOf } from '../../../application';
import { IMAGE_MEDIA_TYPES, type Principal } from '../../../domain';
import { mediaTypeOf, readLimited } from '../rawBody';
import { parse, uploadAttachmentQuery } from '../requestSchemas';

export type AttachmentUseCases = {
  uploadAttachment: Pick<UploadAttachment, 'authorize' | 'execute'>;
  readAttachment: Pick<ReadAttachment, 'execute'>;
  deleteAttachment: Pick<DeleteAttachment, 'execute'>;
};

/**
 * What the browser gets with an image. The type is the one that was stored
 * (checked by its header at upload), never one worked out from a name;
 * `nosniff` and the sandbox mean that an image that is not one is not run.
 */
const IMAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'private, no-cache',
};

/** The routes of the images of a session. */
export class AttachmentsController {
  constructor(private readonly useCases: AttachmentUseCases) {}

  /**
   * `POST /sessions/:id/attachments?name=`. In this order: the owner and the
   * type (nothing of the body is read for a request that fails there), the
   * size (from `Content-Length` before a byte is read, else while reading),
   * then the use case. A failure before the body is read closes the
   * connection, so the body is not read off the socket either.
   */
  async upload(
    principal: Principal,
    sessionId: string,
    req: Request,
    res: Response,
  ): Promise<ChatUploadedAttachment> {
    const { name } = parse(uploadAttachmentQuery, req.query);
    const mediaType = mediaTypeOf(req.headers['content-type']);
    let bytes: Buffer;
    try {
      const { maxBytes } = await this.useCases.uploadAttachment.authorize({
        principal,
        sessionId,
        mediaType,
      });
      bytes = await readLimited(req, maxBytes);
    } catch (error) {
      res.setHeader('Connection', 'close');
      throw error;
    }
    const meta = await this.useCases.uploadAttachment.execute({
      principal,
      sessionId,
      mediaType,
      name,
      bytes,
    });
    return {
      id: meta.id,
      mediaType: meta.mediaType,
      name: meta.name,
      size: meta.size,
    };
  }

  /** `GET /sessions/:id/attachments/:attachmentId` */
  async read(
    principal: Principal,
    sessionId: string,
    attachmentId: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const result = await this.useCases.readAttachment.execute({
      principal,
      sessionId,
      attachmentId,
      ...(req.headers['if-none-match'] !== undefined && {
        ifNoneMatch: req.headers['if-none-match'],
      }),
    });
    res.set({ ...IMAGE_HEADERS, ETag: etagOf(result.meta) });
    if (result.notModified) {
      res.status(304).end();
      return;
    }
    res.status(200).type(result.meta.mediaType).end(Buffer.from(result.bytes));
  }

  /** `DELETE /sessions/:id/attachments/:attachmentId` */
  async delete(
    principal: Principal,
    sessionId: string,
    attachmentId: string,
  ): Promise<void> {
    await this.useCases.deleteAttachment.execute({
      principal,
      sessionId,
      attachmentId,
    });
  }
}

/** What `GET /input-config` answers with: the settings, read from the configuration. */
export function inputConfigOf(settings: {
  images: Omit<ChatInputConfig['images'], 'mediaTypes'>;
  insertMaxPerRun: number;
  queueMaxMessages: number;
  references: { maxPerMessage: number };
}): ChatInputConfig {
  return {
    images: { ...settings.images, mediaTypes: [...IMAGE_MEDIA_TYPES] },
    insertMaxPerRun: settings.insertMaxPerRun,
    queueMaxMessages: settings.queueMaxMessages,
    references: {
      maxPerMessage: settings.references.maxPerMessage,
      maxTextLength: MAX_REFERENCE_TEXT_LENGTH,
    },
  };
}

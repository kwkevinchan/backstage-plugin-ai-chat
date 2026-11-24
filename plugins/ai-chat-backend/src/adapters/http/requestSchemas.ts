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

import { InputError } from '@backstage/errors';
import {
  isEntityRef,
  isPagePath,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { z } from 'zod';

// PostgreSQL cannot store a NUL character in a text column.
const noNul = (text: string) => !text.includes('\u0000');
const NUL_MESSAGE = 'must not contain a NUL character';

/**
 * The page the client says the user is on. The model reads it, so it is not
 * free text: the path is a path (starts with `/`, no blank, no control
 * character) and the entity is an entity reference in the form of the catalog:
 * `[kind:][namespace/]name`, each part with the characters and the length that
 * Backstage allows.
 */
const page = z.object({
  path: z
    .string()
    .min(1)
    .max(2000)
    .refine(
      isPagePath,
      'must be a path that starts with / and has no blank or control character',
    ),
  entityRef: z
    .string()
    .min(1)
    .max(255)
    .refine(
      isEntityRef,
      'must be an entity reference like component:default/name',
    )
    .optional(),
});

const id = z.string().min(1).max(255).refine(noNul, NUL_MESSAGE);

const title = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TITLE_LENGTH)
  .refine(noNul, NUL_MESSAGE);

export const createSessionBody = z.object({
  agentId: id.optional(),
  title: title.optional(),
  entityRef: z
    .string()
    .min(1)
    .max(255)
    .refine(
      isEntityRef,
      'must be an entity reference like component:default/name',
    )
    .optional(),
  enabledToolsets: z.array(id).max(100).optional(),
});

export const updateSessionBody = z.object({
  title: title.nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  enabledToolsets: z.array(id).max(100).optional(),
});

/**
 * The images of a message, by attachment id. The number the administrator
 * allows is checked by the use case; this is the bound of the shape.
 */
const attachmentIds = z
  .array(id)
  .max(100)
  .refine(ids => new Set(ids).size === ids.length, 'must not repeat an id');

const messageText = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MESSAGE_LENGTH)
  .refine(noNul, NUL_MESSAGE);

export const sendMessageBody = z.object({
  text: messageText,
  attachmentIds: attachmentIds.optional(),
  page: page.optional(),
});

export const insertMessageBody = sendMessageBody;

export const queueMessageBody = sendMessageBody;

export const updateQueuedMessageBody = z
  .object({
    text: messageText.optional(),
    attachmentIds: attachmentIds.optional(),
    page: page.nullable().optional(),
  })
  .refine(
    body =>
      body.text !== undefined ||
      body.page !== undefined ||
      body.attachmentIds !== undefined,
    'must change the text, the images or the page',
  );

export const uploadAttachmentQuery = z.object({
  name: z.string().min(1).max(1000).refine(noNul, NUL_MESSAGE),
});

export const reorderQueueBody = z.object({
  ids: z.array(id).max(100),
});

export const decisionBody = z.object({
  approved: z.boolean(),
  page: page.optional(),
});

export const resumeBody = z.object({ page: page.optional() });

export const listQuery = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const afterSeqQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
});

/** The parsed value, or an `InputError` (400) that names the fields. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new InputError(
      `Invalid request: ${result.error.issues
        .map(i => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

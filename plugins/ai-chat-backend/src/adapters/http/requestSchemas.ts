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
  isReferenceUrl,
  MAX_MESSAGE_LENGTH,
  MAX_REFERENCE_TEXT_LENGTH,
  MAX_REFERENCE_TITLE_LENGTH,
  MAX_REFERENCES_PER_MESSAGE,
  MAX_TITLE_LENGTH,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { z } from 'zod';
import { normalizeEntityRef } from '../../domain';

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

/**
 * The text of a message. Empty text is allowed: a message with no text is
 * accepted when it has at least one image. Changing a queued message still
 * requires text (`nonEmptyMessageText`).
 */
const messageText = z
  .string()
  .trim()
  .max(MAX_MESSAGE_LENGTH)
  .refine(noNul, NUL_MESSAGE);

const nonEmptyMessageText = messageText.min(1);

/** An entity ref with a kind: the catalog cannot read an entity without one. */
const entityRefWithKind = z
  .string()
  .min(1)
  .max(255)
  .refine(
    value => isEntityRef(value) && normalizeEntityRef(value) !== undefined,
    'must be an entity reference with a kind, like component:default/name',
  );

/**
 * The references of a message (B-04). The model reads them, so the link of a
 * text snippet is an `http:` or `https:` URL or a path, and the entity is a
 * ref the catalog can read. The number the administrator allows is checked
 * by the use case; this is the most it may be.
 */
const references = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('entity'), entityRef: entityRefWithKind }),
      z.object({
        kind: z.literal('text'),
        text: z
          .string()
          .min(1)
          .max(MAX_REFERENCE_TEXT_LENGTH)
          .refine(noNul, NUL_MESSAGE),
        title: z
          .string()
          .min(1)
          .max(MAX_REFERENCE_TITLE_LENGTH)
          .refine(noNul, NUL_MESSAGE)
          .optional(),
        url: z
          .string()
          .refine(
            isReferenceUrl,
            'must be an http or https URL, or a path that starts with /',
          )
          .optional(),
      }),
    ]),
  )
  .max(MAX_REFERENCES_PER_MESSAGE);

/**
 * A message to send, insert or queue. Text, or at least one image: a message
 * with neither is refused.
 */
const messageBody = z
  .object({
    text: messageText,
    attachmentIds: attachmentIds.optional(),
    page: page.optional(),
    references: references.optional(),
  })
  .refine(
    body => body.text.length > 0 || (body.attachmentIds?.length ?? 0) > 0,
    { message: 'must have text or at least one image', path: ['text'] },
  );

export const sendMessageBody = messageBody;

export const insertMessageBody = messageBody;

export const queueMessageBody = messageBody;

export const updateQueuedMessageBody = z
  .object({
    text: nonEmptyMessageText.optional(),
    attachmentIds: attachmentIds.optional(),
    page: page.nullable().optional(),
    references: references.optional(),
  })
  .refine(
    body =>
      body.text !== undefined ||
      body.page !== undefined ||
      body.attachmentIds !== undefined ||
      body.references !== undefined,
    'must change the text, the images, the page or the references',
  );

export const uploadAttachmentQuery = z.object({
  name: z.string().min(1).max(1000).refine(noNul, NUL_MESSAGE),
});

export const reorderQueueBody = z.object({
  ids: z.array(id).max(100),
});

export const insertQueuedMessageBody = z.object({
  runId: id,
});

export const decisionBody = z.object({
  approved: z.boolean(),
  page: page.optional(),
});

export const resumeBody = z.object({ page: page.optional() });

export const listQuery = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
  // The sessions bound to this entity (SE-06): the same form as a binding,
  // with a kind, normalized as the binding is stored.
  entityRef: z
    .string()
    .min(1)
    .max(255)
    .refine(
      value => isEntityRef(value) && normalizeEntityRef(value) !== undefined,
      'must be an entity reference with a kind, like component:default/name',
    )
    .transform(value => normalizeEntityRef(value)!)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  q: z
    .string()
    .trim()
    .max(MAX_TITLE_LENGTH)
    .refine(noNul, NUL_MESSAGE)
    .optional(),
});

/** The life of a live share; the use case checks the maximum of the administrator. */
const shareHours = z.number().int().min(1).max(100000);

export const createShareBody = z.object({
  subjectRef: z.string().trim().min(1).max(255).refine(noNul, NUL_MESSAGE),
  mode: z.enum(['snapshot', 'live']).optional(),
  includeToolOutputs: z.boolean().optional(),
  includeLaterToolOutputs: z.boolean().optional(),
  hours: shareHours.optional(),
});

export const updateShareBody = z
  .object({
    refresh: z.literal(true).optional(),
    includeToolOutputs: z.boolean().optional(),
    includeLaterToolOutputs: z.boolean().optional(),
    hours: shareHours.optional(),
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'must change at least one field',
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

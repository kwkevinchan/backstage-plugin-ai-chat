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
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { z } from 'zod';

// PostgreSQL cannot store a NUL character in a text column.
const noNul = (text: string) => !text.includes('\u0000');
const NUL_MESSAGE = 'must not contain a NUL character';

const page = z.object({
  path: z.string().min(1).max(2000).refine(noNul, NUL_MESSAGE),
  entityRef: z.string().min(1).max(255).refine(noNul, NUL_MESSAGE).optional(),
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
  entityRef: z.string().min(1).max(255).refine(noNul, NUL_MESSAGE).optional(),
  enabledToolsets: z.array(id).max(100).optional(),
});

export const updateSessionBody = z.object({
  title: title.nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  enabledToolsets: z.array(id).max(100).optional(),
});

export const sendMessageBody = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAX_MESSAGE_LENGTH)
    .refine(noNul, NUL_MESSAGE),
  page: page.optional(),
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

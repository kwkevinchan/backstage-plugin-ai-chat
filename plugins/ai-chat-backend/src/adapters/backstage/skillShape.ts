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
import type { Skill } from '@kwkevinchan/ai-chat-harness';
import { assertExtensionId } from './agentShape';

/** Maximum characters kept for a one-line skill description (D-22). */
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;

/**
 * Checks and collapses a skill description to one non-empty line within
 * {@link MAX_SKILL_DESCRIPTION_CHARS}.
 */
export function normalizeSkillDescription(
  value: unknown,
  path: string,
): string {
  if (typeof value !== 'string') {
    throw new InputError(`${path} must be a string`);
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    throw new InputError(`${path} must not be empty`);
  }
  if (normalized.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new InputError(
      `${path} must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters`,
    );
  }
  return normalized;
}

/** Validates a skill registered through `aiChatHarnessExtensionPoint.addSkill`. */
export function readExtensionSkill(value: unknown): Skill {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError('skill must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') {
    throw new InputError('skill: id must be a string');
  }
  assertExtensionId(record.id, `skill ${record.id}`);
  const description = normalizeSkillDescription(
    record.description,
    `skill ${record.id}.description`,
  );
  if (typeof record.load !== 'function') {
    throw new InputError(`skill ${record.id}: load must be a function`);
  }
  const load = record.load as Skill['load'];
  return {
    id: record.id,
    description,
    load: ctx => load.call(value, ctx),
  };
}

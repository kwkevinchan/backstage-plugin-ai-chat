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
import { parse } from 'yaml';
import { assertExtensionId } from '../backstage/agentShape';
import { normalizeSkillDescription } from '../backstage/skillShape';

/** Maximum size in bytes allowed for a single `SKILL.md` file. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

export type ParsedSkillMarkdown = {
  id: string;
  description: string;
  body: string;
};

/**
 * Parses and validates a `SKILL.md` file (D-22): YAML frontmatter starting
 * with `---` containing `name` and `description`, followed by a non-empty
 * Markdown body.
 */
export function parseSkillMarkdown(
  raw: string,
  sourceLabel: string,
): ParsedSkillMarkdown {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    throw new InputError(
      `${sourceLabel}: SKILL.md must start with YAML frontmatter (---)`,
    );
  }
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex < 0) {
    throw new InputError(
      `${sourceLabel}: SKILL.md frontmatter is missing a closing ---`,
    );
  }

  const frontmatterRaw = lines.slice(1, closingIndex).join('\n');
  let frontmatter: unknown;
  try {
    frontmatter = parse(frontmatterRaw);
  } catch (error) {
    throw new InputError(
      `${sourceLabel}: invalid SKILL.md frontmatter: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof frontmatter !== 'object' ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  ) {
    throw new InputError(
      `${sourceLabel}: SKILL.md frontmatter must be a YAML mapping`,
    );
  }

  const meta = frontmatter as Record<string, unknown>;
  if (typeof meta.name !== 'string') {
    throw new InputError(`${sourceLabel}: SKILL.md frontmatter requires name`);
  }
  assertExtensionId(meta.name, `${sourceLabel} frontmatter.name`);
  const description = normalizeSkillDescription(
    meta.description,
    `${sourceLabel} frontmatter.description`,
  );

  const body = lines
    .slice(closingIndex + 1)
    .join('\n')
    .trim();
  if (body.length === 0) {
    throw new InputError(`${sourceLabel}: SKILL.md body must not be empty`);
  }

  return { id: meta.name, description, body };
}

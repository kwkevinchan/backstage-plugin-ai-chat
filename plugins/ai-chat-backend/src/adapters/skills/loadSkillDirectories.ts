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

import type { LoggerService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import type { Skill, StepContext } from '@kwkevinchan/ai-chat-harness';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_SKILL_FILE_BYTES, parseSkillMarkdown } from './skillMarkdown';

const SKILL_FILENAME = 'SKILL.md';

/**
 * Scans configured `aiChat.skills.directories` at startup (X-04, D-22).
 *
 * Only metadata (`id` and `description`) is retained after startup validation;
 * the Markdown body is read lazily from disk when `load()` is called via
 * `load_skill`.
 */
export async function loadSkillsFromDirectories(
  directories: readonly string[],
  logger: LoggerService,
): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const dir of directories) {
    const dirPath = resolve(dir);
    await assertReadableDirectory(dirPath, dir);
    const entries = (await readdir(dirPath)).sort();

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const entryPath = join(dirPath, entry);
      const entryStat = await stat(entryPath);
      if (!entryStat.isDirectory()) continue;

      const skillFile = join(entryPath, SKILL_FILENAME);
      const fileStat = await statFileOrMissing(skillFile);
      if (!fileStat) continue;

      const label = `${entry}/${SKILL_FILENAME}`;
      if (!fileStat.isFile()) {
        throw new InputError(`${label}: must be a regular file`);
      }
      if (fileStat.size > MAX_SKILL_FILE_BYTES) {
        throw new InputError(
          `${label}: exceeds maximum size of ${MAX_SKILL_FILE_BYTES} bytes`,
        );
      }

      const raw = await readFile(skillFile, 'utf8');
      const parsed = parseSkillMarkdown(raw, label);
      if (parsed.id !== entry) {
        throw new InputError(
          `${label}: frontmatter name '${parsed.id}' must match directory name '${entry}'`,
        );
      }
      if (seen.has(parsed.id)) {
        throw new InputError(`skill ${parsed.id} is already defined`);
      }
      seen.add(parsed.id);

      skills.push(
        lazyDirectorySkill(parsed.id, parsed.description, skillFile, logger),
      );
    }
  }

  return skills;
}

/** Combines directory skills and module-registered skills, rejecting duplicates. */
export function mergeSkills(
  directorySkills: readonly Skill[],
  registeredSkills: readonly Skill[],
): Skill[] {
  const merged: Skill[] = [];
  const seen = new Set<string>();
  for (const skill of [...directorySkills, ...registeredSkills]) {
    if (seen.has(skill.id)) {
      throw new InputError(`skill ${skill.id} is already defined`);
    }
    seen.add(skill.id);
    merged.push(skill);
  }
  return merged;
}

function lazyDirectorySkill(
  id: string,
  description: string,
  skillFile: string,
  logger: LoggerService,
): Skill {
  return {
    id,
    description,
    async load(ctx: StepContext): Promise<string> {
      try {
        const info = await stat(skillFile);
        if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) {
          throw new Error(`Invalid SKILL.md size or file type for ${id}`);
        }
        const raw = await readFile(skillFile, {
          encoding: 'utf8',
          signal: ctx.signal,
        });
        return parseSkillMarkdown(raw, `${id}/${SKILL_FILENAME}`).body;
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        logger.warn(`Failed to load skill ${id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(`Could not load skill ${id}.`);
      }
    },
  };
}

async function assertReadableDirectory(
  resolvedPath: string,
  configured: string,
): Promise<void> {
  try {
    const info = await stat(resolvedPath);
    if (!info.isDirectory()) {
      throw new InputError(
        `aiChat.skills.directories entry '${configured}' is not a directory`,
      );
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      `aiChat.skills.directories entry '${configured}' cannot be read`,
    );
  }
}

async function statFileOrMissing(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

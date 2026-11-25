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
  AgentDefinition,
  JsonObject,
  ToolCallItem,
  ToolDescriptor,
} from '../../domain';
import type { Skill } from '../ports/extensions';
import type { ToolOutput, ValidationResult } from '../ports/ToolGateway';
import type { AdvanceRunRequest } from '../types';
import { stepContextOf } from './stepContext';

/**
 * Built-in read-only tool id that loads the full instructions of an available
 * skill on demand (D-08, X-04).
 *
 * @public
 */
export const LOAD_SKILL_TOOL_ID = 'load_skill';

const LOAD_SKILL_SCHEMA_HASH = 'builtin:load_skill:v1';

/**
 * Resolves the skills available to `agent` from the registered set (X-04).
 *
 * - Registered skills are deduplicated by `id` (first wins).
 * - When `agent.skills` is defined, only listed skills are returned, in the
 *   agent's order (`[]` disables skills for that agent).
 * - When `agent.skills` is omitted, all registered skills are available.
 *
 * @public
 */
export function resolveAgentSkills(
  agent: AgentDefinition,
  registered?: readonly Skill[],
): Skill[] {
  const byId = new Map<string, Skill>();
  for (const skill of registered ?? []) {
    if (!byId.has(skill.id)) {
      byId.set(skill.id, skill);
    }
  }
  if (agent.skills !== undefined) {
    const resolved: Skill[] = [];
    for (const id of agent.skills) {
      const skill = byId.get(id);
      if (skill) resolved.push(skill);
    }
    return resolved;
  }
  return [...byId.values()];
}

/**
 * Builds the `ToolDescriptor` for the built-in `load_skill` tool (X-04). It is
 * marked `readOnly: true`, so default policy offers and runs it with `allow`.
 *
 * @public
 */
export function loadSkillDescriptor(skills: readonly Skill[]): ToolDescriptor {
  return {
    id: LOAD_SKILL_TOOL_ID,
    title: 'Load skill',
    description: 'Load the full instructions for an available skill by its id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          enum: skills.map(skill => skill.id),
          description: 'The id of the skill to load.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    schemaHash: LOAD_SKILL_SCHEMA_HASH,
    readOnly: true,
  };
}

/**
 * Formats only each skill's id and one-line description for the model context
 * (X-04). Never calls `skill.load()`.
 */
export function skillsContextBlock(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map(
    skill => `- ${skill.id}: ${normalizeInline(skill.description)}`,
  );
  return [
    'Available skills (call `load_skill` with the skill `id` when you need its full instructions):',
    ...lines,
  ].join('\n');
}

/** Validates `{ id }` input for `load_skill` against `skills`. */
export function validateLoadSkillInput(
  input: JsonObject,
  skills: readonly Skill[],
): ValidationResult {
  const keys = Object.keys(input);
  for (const key of keys) {
    if (key !== 'id') {
      return {
        valid: false,
        message: `Unexpected property '${key}' in load_skill input.`,
      };
    }
  }
  const { id } = input;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return {
      valid: false,
      message: 'load_skill requires a non-empty string "id".',
    };
  }
  if (!skills.some(skill => skill.id === id)) {
    return {
      valid: false,
      message: `Unknown skill: ${id}`,
    };
  }
  return { valid: true };
}

/**
 * Executes the built-in `load_skill` call, passing `StepContext` to
 * `skill.load()` and returning `{ id, description, content }` without leaking
 * internal errors or filesystem paths. Returns `undefined` when aborted.
 */
export async function executeLoadSkill(
  call: ToolCallItem,
  req: AdvanceRunRequest,
  skills: readonly Skill[],
): Promise<ToolOutput | undefined> {
  const { id } = call.input;
  if (typeof id !== 'string') {
    return {
      status: 'error',
      message: 'load_skill requires a string "id".',
    };
  }
  const skill = skills.find(item => item.id === id);
  if (!skill) {
    return {
      status: 'error',
      message: `Unknown skill: ${id}`,
    };
  }
  try {
    const content = await skill.load(stepContextOf(req, call.step));
    if (req.signal.aborted) return undefined;
    if (typeof content !== 'string') {
      return {
        status: 'error',
        message: 'The skill returned invalid content.',
      };
    }
    return {
      status: 'ok',
      output: {
        id: skill.id,
        description: normalizeInline(skill.description),
        content,
      },
    };
  } catch {
    if (req.signal.aborted) return undefined;
    return {
      status: 'error',
      message: `Could not load skill ${skill.id}.`,
    };
  }
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

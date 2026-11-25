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
import type {
  AgentDefinition,
  AgentLimits,
  PlanningMode,
} from '@kwkevinchan/ai-chat-harness';

/**
 * The same shape as a toolset id: a letter, then letters, digits, and `-` or
 * `_` between those parts. Agents, skills, models and context providers share
 * it (X-01).
 */
const EXTENSION_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i;

const AGENT_FIELDS = new Set([
  'id',
  'title',
  'systemPrompt',
  'toolsets',
  'skills',
  'model',
  'limits',
  'planning',
]);

const LIMIT_FIELDS = new Set([
  'maxSteps',
  'maxToolCallsPerRun',
  'runTimeoutSeconds',
]);

/** The fields of an agent, before the catalog decides the system prompt. */
export type AgentBody = {
  title?: string;
  systemPrompt?: string;
  toolsets?: readonly string[];
  skills?: readonly string[];
  model?: string;
  limits?: AgentLimits;
  planning?: PlanningMode;
};

/** `path` is where the id is written, so the error can name it. */
export function assertExtensionId(id: string, path: string): void {
  if (!EXTENSION_ID.test(id)) {
    throw new InputError(
      `${path}: the id must start with a letter and may only have letters, digits, - and _ between them`,
    );
  }
}

/**
 * Checks the fields of one agent. `systemPrompt` may be omitted: the catalog
 * then uses the installation prompt for a configured agent, and refuses an
 * extension agent. Ids of toolsets are not checked against the installation
 * here; the catalog does that, because a module does not know the toolsets.
 */
export function readAgentBody(value: unknown, path: string): AgentBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!AGENT_FIELDS.has(key)) {
      throw new InputError(`${path}.${key} is not a field of an agent`);
    }
  }

  const body: AgentBody = {};
  if ('title' in record) body.title = readString(record.title, `${path}.title`);
  if ('systemPrompt' in record) {
    body.systemPrompt = readString(record.systemPrompt, `${path}.systemPrompt`);
  }
  if ('toolsets' in record) {
    body.toolsets = readIdList(record.toolsets, `${path}.toolsets`, 'toolset');
  }
  if ('skills' in record) {
    body.skills = readIdList(record.skills, `${path}.skills`, 'skill');
  }
  if ('model' in record) {
    if (typeof record.model !== 'string') {
      throw new InputError(`${path}.model must be an id`);
    }
    assertExtensionId(record.model, `${path}.model`);
    body.model = record.model;
  }
  if ('planning' in record) {
    if (record.planning !== 'required') {
      throw new InputError(`${path}.planning must be required`);
    }
    body.planning = 'required';
  }
  if ('limits' in record)
    body.limits = readLimits(record.limits, `${path}.limits`);
  return body;
}

/** An agent a module registered. The catalog then wraps the prompt with the built-in rules. */
export function readExtensionAgent(value: unknown): AgentDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError('agent must be an object');
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string')
    throw new InputError('agent: id must be a string');
  assertExtensionId(id, `agent ${id}`);
  const body = readAgentBody(value, `agent ${id}`);
  if (typeof body.systemPrompt !== 'string') {
    throw new InputError(`agent ${id}: systemPrompt must be a string`);
  }
  return definitionFrom(id, body, body.systemPrompt);
}

/** Puts the present optional fields on the definition and leaves the rest off. */
export function definitionFrom(
  id: string,
  body: AgentBody,
  systemPrompt: string,
): AgentDefinition {
  return {
    id,
    systemPrompt,
    ...(body.title !== undefined && { title: body.title }),
    ...(body.toolsets !== undefined && { toolsets: body.toolsets }),
    ...(body.skills !== undefined && { skills: body.skills }),
    ...(body.model !== undefined && { model: body.model }),
    ...(body.limits !== undefined && { limits: body.limits }),
    ...(body.planning !== undefined && { planning: body.planning }),
  };
}

/**
 * Every toolset an agent names has to be one the installation defined. With
 * no `aiChat.toolsets`, the only id is the implicit `default` toolset.
 */
export function assertKnownToolsets(
  toolsets: readonly string[] | undefined,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const id of toolsets ?? []) {
    if (!known.has(id)) {
      throw new InputError(`${path}.toolsets: unknown toolset ${id}`);
    }
  }
}

/**
 * Every skill an agent names must exist in the merged set of directory and
 * extension skills when skill validation is active.
 */
export function assertKnownSkills(
  skills: readonly string[] | undefined,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const id of skills ?? []) {
    if (!known.has(id)) {
      throw new InputError(`${path}.skills: unknown skill ${id}`);
    }
  }
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new InputError(`${path} must be a string`);
  }
  return value;
}

function readIdList(
  value: unknown,
  path: string,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new InputError(`${path} must be an array of ${label} ids`);
  }
  const seen = new Set<string>();
  for (const id of value) {
    assertExtensionId(id, path);
    if (seen.has(id)) {
      throw new InputError(`${path}: ${label} ${id} is repeated`);
    }
    seen.add(id);
  }
  return value;
}

function readLimits(value: unknown, path: string): AgentLimits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!LIMIT_FIELDS.has(key)) {
      throw new InputError(`${path}.${key} is not a limit`);
    }
  }
  const limits: AgentLimits = {};
  if ('maxSteps' in record) {
    limits.maxSteps = readCount(record.maxSteps, `${path}.maxSteps`);
  }
  if ('maxToolCallsPerRun' in record) {
    limits.maxToolCallsPerRun = readCount(
      record.maxToolCallsPerRun,
      `${path}.maxToolCallsPerRun`,
    );
  }
  if ('runTimeoutSeconds' in record) {
    limits.runTimeoutSeconds = readCount(
      record.runTimeoutSeconds,
      `${path}.runTimeoutSeconds`,
      600,
    );
  }
  return limits;
}

/** An integer from 0. `max` is the installation cap on the run timeout. */
function readCount(value: unknown, path: string, max?: number): number {
  const above = typeof value === 'number' && max !== undefined && value > max;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    above
  ) {
    throw new InputError(
      max === undefined
        ? `${path} must be an integer greater than or equal to 0`
        : `${path} must be an integer from 0 to ${max}`,
    );
  }
  return value;
}

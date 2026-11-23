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

import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type {
  ActionsService,
  ActionsServiceAction,
} from '@backstage/backend-plugin-api/alpha';
import type { JSONSchema7 } from 'json-schema';
import type { LlmTool } from '../llm/OpenAiCompatibleClient';

/** The longest function name that OpenAI-compatible servers accept. */
const MAX_TOOL_NAME_LENGTH = 64;

/** `*` matches any characters, including `:`; everything else matches itself. */
export function matchesPattern(pattern: string, actionId: string): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(actionId);
}

export function isActionOffered(
  actionId: string,
  filter: { include: string[]; exclude: string[] },
): boolean {
  if (filter.exclude.some(p => matchesPattern(p, actionId))) return false;
  return (
    filter.include.length === 0 ||
    filter.include.some(p => matchesPattern(p, actionId))
  );
}

/**
 * The function names of the model must match `^[a-zA-Z0-9_-]+$` and are at
 * most 64 characters; action IDs have a colon (`catalog:get-entity`). The
 * name is the ID with every other character replaced by `_`, made unique with
 * a number when two IDs give the same name.
 */
export function assignToolNames(actionIds: string[]): Map<string, string> {
  const byName = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const id of [...actionIds].sort()) {
    const base = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    let name = base.slice(0, MAX_TOOL_NAME_LENGTH);
    for (let n = 2; byName.has(name); n++) {
      const suffix = `_${n}`;
      name = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    }
    byName.set(name, id);
    byId.set(id, name);
  }
  return byId;
}

function toParameters(schema: JSONSchema7 | undefined): JSONSchema7 {
  if (!schema || schema.type !== 'object') {
    return { type: 'object', properties: {} };
  }
  // Some servers refuse the `$schema` keyword.
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

/**
 * The actions that the chat offers to the model for one user: the result of
 * the actions service for the credentials of the user, narrowed by the
 * include and exclude patterns of the plugin.
 */
export class ToolCatalog {
  private constructor(
    private readonly actionsByName: Map<string, ActionsServiceAction>,
  ) {}

  static async load(
    actions: ActionsService,
    credentials: BackstageCredentials,
    filter: { include: string[]; exclude: string[] },
  ): Promise<ToolCatalog> {
    const { actions: listed } = await actions.list({ credentials });
    // An action that wants secrets cannot be called from a chat.
    const offered = listed.filter(
      action => !action.schema.secrets && isActionOffered(action.id, filter),
    );
    const names = assignToolNames(offered.map(a => a.id));
    const byName = new Map<string, ActionsServiceAction>();
    for (const action of offered) byName.set(names.get(action.id)!, action);
    return new ToolCatalog(byName);
  }

  /** The tool definitions for the model, in a stable order. */
  tools(): LlmTool[] {
    return [...this.actionsByName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, action]) => ({
        type: 'function' as const,
        function: {
          name,
          description: `${action.title}: ${action.description}`,
          parameters: toParameters(action.schema.input),
        },
      }));
  }

  /** The action for a function name of the model; undefined for an unknown name. */
  resolve(toolName: string): ActionsServiceAction | undefined {
    return this.actionsByName.get(toolName);
  }
}

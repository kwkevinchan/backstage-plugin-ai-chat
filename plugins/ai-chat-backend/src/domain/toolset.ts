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
  PolicySettings,
  ToolDescriptor,
} from '@kwkevinchan/ai-chat-harness';

/**
 * A group of tools. The administrator defines it in the configuration (T-01,
 * D-24); the user switches it on or off in their own session within those
 * bounds (T-11).
 */
export type Toolset = {
  id: string;
  title?: string;
  /** Action ID patterns; `*` matches any characters, `:` included. */
  actions: readonly string[];
  /** Action ID patterns that are not part of the toolset. */
  exclude: readonly string[];
  /** Whether a new session has the toolset switched on. */
  default: boolean;
  /** Whether the tools send data out of the organization (T-04). */
  egress: boolean;
};

/** `*` matches any characters, including `:`; everything else matches itself. */
export function matchesActionPattern(
  pattern: string,
  actionId: string,
): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(actionId);
}

/** The toolsets that contain an action. */
export function toolsetsOf(
  actionId: string,
  toolsets: readonly Toolset[],
): Toolset[] {
  return toolsets.filter(
    toolset =>
      toolset.actions.some(p => matchesActionPattern(p, actionId)) &&
      !toolset.exclude.some(p => matchesActionPattern(p, actionId)),
  );
}

/** Whether an action is in a toolset that sends data out (T-04). */
export function isEgress(
  actionId: string,
  toolsets: readonly Toolset[],
): boolean {
  return toolsetsOf(actionId, toolsets).some(toolset => toolset.egress);
}

/** The ids of the toolsets that a new session has switched on (D-24). */
export function defaultToolsetIds(toolsets: readonly Toolset[]): string[] {
  return toolsets.filter(toolset => toolset.default).map(toolset => toolset.id);
}

/**
 * The tools that go to the model for one session (T-02, T-11): those in a
 * toolset the session has switched on. A tool in no switched-on toolset is not
 * offered; an id in `sessionChoice` that is not a toolset is ignored, so the
 * session never reaches beyond what the administrator defined.
 */
export function enabledTools(
  all: readonly ToolDescriptor[],
  toolsets: readonly Toolset[],
  sessionChoice: readonly string[],
): ToolDescriptor[] {
  const chosen = new Set(sessionChoice);
  const active = toolsets.filter(toolset => chosen.has(toolset.id));
  return all.filter(tool => toolsetsOf(tool.id, active).length > 0);
}

/**
 * The tools the policy sets to `allow` although they are not read-only or
 * send data out (`egress`). The policy never lets them run without approval
 * (D-06, T-03, T-04); the list is for a warning to the administrator.
 */
export function unsafeAllows(
  tools: readonly ToolDescriptor[],
  settings: PolicySettings,
): string[] {
  const byTool = settings.byTool ?? {};
  return tools
    .filter(
      tool =>
        (tool.readOnly !== true || tool.egress === true) &&
        Object.prototype.hasOwnProperty.call(byTool, tool.id) &&
        byTool[tool.id] === 'allow',
    )
    .map(tool => tool.id);
}

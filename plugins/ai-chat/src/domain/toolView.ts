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

import type { ToolPart } from './types';

/** The text of a call whose result was never stored although it may have run. */
export const RESULT_NOT_KNOWN = 'The result of the call is not known.';

/** The text of a call that did not run, because its run ended first. */
export const NOT_RUN = 'The call did not run.';

/** How the screen shows a tool call. */
export type ToolStatus =
  | 'waiting' // asks for the decision of the user
  | 'allowed' // decided to run, no result yet
  | 'running' // runs without a decision, no result yet
  | 'done'
  | 'failed'
  | 'rejected'
  | 'unknown' // may have run; the result was not stored
  | 'not_run'; // did not run, because the run ended first

/** The id of the action of a tool part: the name that follows `tool-`. */
export function toolIdOf(part: ToolPart): string {
  return part.type.startsWith('tool-')
    ? part.type.slice('tool-'.length)
    : part.type;
}

/** A readable title for the id of an action, such as `plugin:list-services`. */
export function titleOfTool(toolId: string): string {
  const name = toolId.split(/[:.]/).pop() || toolId;
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function statusOfTool(part: ToolPart): ToolStatus {
  switch (part.state) {
    case 'approval-requested':
      return 'waiting';
    case 'approval-responded':
      return part.approval.approved ? 'allowed' : 'rejected';
    case 'output-available':
      return 'done';
    case 'output-denied':
      return 'rejected';
    case 'output-error':
      if (part.errorText === RESULT_NOT_KNOWN) return 'unknown';
      if (part.errorText === NOT_RUN) return 'not_run';
      return 'failed';
    default:
      return 'running';
  }
}

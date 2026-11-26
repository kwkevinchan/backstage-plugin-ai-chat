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

import type { AiChatToolResultStatus } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { UPDATE_PLAN_TOOL } from './plan';
import type { ToolStatus } from './toolView';

/**
 * The tools of the core. The chat draws them itself, so a result component
 * registered for one of these ids is not used.
 */
export const BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
  UPDATE_PLAN_TOOL,
  'load_skill',
]);

export function isBuiltInTool(toolId: string): boolean {
  return BUILT_IN_TOOLS.has(toolId);
}

/**
 * The status a result component receives, or `undefined` when it is not
 * shown: a call that waits for a decision belongs to the approval card, and a
 * call that did not run has no result.
 */
export function resultStatusOf(
  status: ToolStatus,
): AiChatToolResultStatus | undefined {
  switch (status) {
    case 'allowed':
    case 'running':
      return 'running';
    case 'done':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'denied';
    case 'unknown':
      return 'unknown';
    default:
      return undefined;
  }
}

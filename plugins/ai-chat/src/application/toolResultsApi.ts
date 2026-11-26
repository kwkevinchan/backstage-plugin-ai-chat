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

import type { ComponentType } from 'react';
import type {
  AiChatToolResult,
  AiChatToolResultProps,
  AiChatToolResultsApi,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { isBuiltInTool } from '../domain/toolResults';

/**
 * Makes the result component API of the chat from the components of the
 * plugins. The first component for an action id is used; a later one for the
 * same id, one for a tool of the core (`update_plan`, `load_skill`) and one
 * without an action id or a component are left out with a warning in the
 * console.
 *
 * On the legacy frontend system, the app replaces `aiChatToolResultsApiRef`
 * with the API this returns. The new frontend system builds it from the
 * extensions of `AiChatToolResultBlueprint`.
 *
 * @public
 */
export function createAiChatToolResultsApi(
  results: Iterable<AiChatToolResult>,
): AiChatToolResultsApi {
  const components = new Map<string, ComponentType<AiChatToolResultProps>>();
  for (const result of results) {
    const { actionId, component } = result ?? {};
    if (typeof actionId !== 'string' || actionId === '' || !component) {
      // eslint-disable-next-line no-console
      console.warn(
        'ai-chat: a result component needs an action id and a component; it is not used.',
      );
      continue;
    }
    if (isBuiltInTool(actionId)) {
      // eslint-disable-next-line no-console
      console.warn(
        `ai-chat: ${actionId} is a tool of the chat and keeps its own view; the result component for it is not used.`,
      );
      continue;
    }
    if (components.has(actionId)) {
      // eslint-disable-next-line no-console
      console.warn(
        `ai-chat: a result component for ${actionId} is registered already; the later one is not used.`,
      );
      continue;
    }
    components.set(actionId, component);
  }
  return {
    getComponent: actionId => components.get(actionId),
  };
}

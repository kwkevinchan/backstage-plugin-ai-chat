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

/**
 * Entry point of the new frontend system: the blueprint that adds a result
 * component for an action to the chat.
 *
 * @packageDocumentation
 */

import {
  createExtensionBlueprint,
  createExtensionDataRef,
} from '@backstage/frontend-plugin-api';
import type { AiChatToolResult } from './toolResults';

const toolResultDataRef = createExtensionDataRef<AiChatToolResult>().with({
  id: 'ai-chat.tool-result',
});

/**
 * Adds a result component for one action to the chat. The extension attaches
 * to the `toolResults` input of `api:ai-chat/tool-results`, which the chat
 * plugin provides. When two extensions name the same action, the one that
 * comes first in the input is used and the chat warns in the console.
 *
 * @example
 * ```tsx
 * AiChatToolResultBlueprint.make({
 *   name: 'list-services',
 *   params: { actionId: 'my-plugin:list-services', component: ServicesTable },
 * });
 * ```
 *
 * @alpha
 */
export const AiChatToolResultBlueprint = createExtensionBlueprint({
  kind: 'ai-chat-tool-result',
  attachTo: { id: 'api:ai-chat/tool-results', input: 'toolResults' },
  output: [toolResultDataRef],
  dataRefs: { toolResult: toolResultDataRef },
  *factory(params: AiChatToolResult) {
    yield toolResultDataRef({
      actionId: params.actionId,
      component: params.component,
    });
  },
});

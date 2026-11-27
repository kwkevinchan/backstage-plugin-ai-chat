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
 * Entry point of the new frontend system: the blueprints that add a result
 * component for an action and a reference source to the chat.
 *
 * @packageDocumentation
 */

import {
  createExtensionBlueprint,
  createExtensionDataRef,
} from '@backstage/frontend-plugin-api';
import type { AiChatReferenceSource } from './references';
import type { AiChatToolResult } from './toolResults';

export type {
  AiChatReference,
  AiChatReferenceSource,
  AiChatReferenceSourceProps,
} from './references';
export type {
  AiChatToolResult,
  AiChatToolResultProps,
  AiChatToolResultStatus,
} from './toolResults';

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

const referenceSourceDataRef =
  createExtensionDataRef<AiChatReferenceSource>().with({
    id: 'ai-chat.reference-source',
  });

/**
 * Adds a reference source to the "Add reference" menu of the chat. The
 * extension attaches to the `referenceSources` input of
 * `api:ai-chat/reference-sources`, which the chat plugin provides. When two
 * extensions have the same id, the one that comes first in the input is used
 * and the chat warns in the console.
 *
 * @example
 * ```tsx
 * AiChatReferenceSourceBlueprint.make({
 *   name: 'docs-page',
 *   params: { id: 'docs-page', title: 'Documentation page', component: DocsPagePicker },
 * });
 * ```
 *
 * @alpha
 */
export const AiChatReferenceSourceBlueprint = createExtensionBlueprint({
  kind: 'ai-chat-reference-source',
  attachTo: { id: 'api:ai-chat/reference-sources', input: 'referenceSources' },
  output: [referenceSourceDataRef],
  dataRefs: { referenceSource: referenceSourceDataRef },
  *factory(params: AiChatReferenceSource) {
    yield referenceSourceDataRef({
      id: params.id,
      title: params.title,
      component: params.component,
    });
  },
});

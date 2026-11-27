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
  AiChatReferenceSource,
  AiChatReferenceSourcesApi,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';

/**
 * The reference sources of the "Add reference" menu, for the legacy frontend
 * system. An app replaces `aiChatReferenceSourcesApiRef` with it:
 *
 * ```ts
 * createApiFactory({
 *   api: aiChatReferenceSourcesApiRef,
 *   deps: {},
 *   factory: () => createAiChatReferenceSourcesApi([docsPageSource]),
 * });
 * ```
 *
 * The sources keep their order. A source without an id, a title or a
 * component is not used. When two sources have the same id, the first one is
 * used; the chat warns in the console about the other one.
 *
 * @public
 */
export function createAiChatReferenceSourcesApi(
  sources: Iterable<AiChatReferenceSource>,
): AiChatReferenceSourcesApi {
  const taken: AiChatReferenceSource[] = [];
  for (const source of sources) {
    const { id, title, component } = source ?? {};
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof title !== 'string' ||
      title === '' ||
      !component
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'ai-chat: a reference source needs an id, a title and a component; it is not used.',
      );
      continue;
    }
    if (taken.some(other => other.id === id)) {
      // eslint-disable-next-line no-console
      console.warn(
        `ai-chat: a reference source with the id ${id} is registered already; the later one is not used.`,
      );
      continue;
    }
    taken.push({ id, title, component });
  }
  return { getSources: () => taken };
}

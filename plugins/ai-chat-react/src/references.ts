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
import { createApiRef } from '@backstage/core-plugin-api';

/**
 * Something the user adds to a message for the assistant to read: an entity
 * of the catalog, which the chat reads with the credentials of the user, or a
 * text snippet with the title and the link of where it is from.
 *
 * - `entityRef` has a kind: `kind:namespace/name` or `kind:name`.
 * - `text` longer than the limit of the backend (4,000 characters by
 *   default) is cut, and the chat marks it as truncated.
 * - `url` is an `http:` or `https:` URL or a path of this site that starts
 *   with `/`; another link is left out.
 *
 * The text is sent to the model provider. Do not put secrets in it.
 *
 * @public
 */
export type AiChatReference =
  | { kind: 'entity'; entityRef: string }
  | { kind: 'text'; text: string; title?: string; url?: string };

/**
 * What the component of a reference source receives. The chat shows the
 * component in a dialog when the user picks the source in "Add reference".
 *
 * @public
 */
export interface AiChatReferenceSourceProps {
  /**
   * Adds references to the message the user writes. References over the
   * limit of one message are not added. It can be called more than once.
   */
  onAdd(references: AiChatReference[]): void;
  /** Closes the dialog. */
  onClose(): void;
}

/**
 * A place references come from, such as the pages of the documentation. It
 * is an item of the "Add reference" menu of the chat.
 *
 * @public
 */
export interface AiChatReferenceSource {
  /** An id that no other source uses, such as `techdocs-page`. */
  id: string;
  /** The name of the item in the menu. */
  title: string;
  /** The component that lets the user choose, shown in a dialog. */
  component: ComponentType<AiChatReferenceSourceProps>;
}

/**
 * The reference sources of the plugins, in the order they were registered.
 *
 * @public
 */
export interface AiChatReferenceSourcesApi {
  /** Every source, in the order of registration. */
  getSources(): AiChatReferenceSource[];
}

/**
 * The reference sources. The chat plugin registers an empty list; in the
 * legacy frontend system an app replaces it with
 * `createAiChatReferenceSourcesApi([...])` of the chat plugin. The new
 * frontend system collects `AiChatReferenceSourceBlueprint` extensions of
 * `/alpha`.
 *
 * @public
 */
export const aiChatReferenceSourcesApiRef =
  createApiRef<AiChatReferenceSourcesApi>({
    id: 'plugin.ai-chat.reference-sources',
  });

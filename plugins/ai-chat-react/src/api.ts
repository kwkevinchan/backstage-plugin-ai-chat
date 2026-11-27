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

import { createApiRef } from '@backstage/core-plugin-api';

/**
 * What a plugin asks the panel to open with. A missing field is left out.
 * A blank prompt and an entity that is not an entity reference are left out
 * by the panel.
 *
 * @public
 */
export interface AiChatLaunchRequest {
  /** The first message of a new conversation. */
  prompt?: string;
  /** The entity this conversation is about, `kind:namespace/name`. */
  entityRef?: string;
}

/**
 * The side panel API as another plugin sees it: open, close, and subscribe to
 * whether it is open.
 *
 * The chat plugin implements this API. Replacing the implementation is not
 * supported: the panel needs the one the plugin registers.
 *
 * @public
 */
export interface AiChatPanelApi {
  /** Whether the panel is open. */
  isOpen(): boolean;
  /**
   * Opens the panel. A request that sets `prompt` or `entityRef` is a launch:
   * a prompt starts a new conversation, and an entity reference stays with the
   * messages. With neither field, the panel opens and the conversation and the
   * previous launch stay.
   */
  open(request?: AiChatLaunchRequest): void;
  /** Closes the panel. The conversation and the launch stay. */
  close(): void;
  /**
   * Calls `listener` when `isOpen()` changes. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * The API reference of the AI chat side panel.
 *
 * @public
 */
export const aiChatPanelApiRef = createApiRef<AiChatPanelApi>({
  id: 'plugin.ai-chat.panel',
});

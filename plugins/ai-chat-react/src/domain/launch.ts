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

import {
  isEntityRef,
  type ChatPageContext,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';

/**
 * What a plugin asks the panel to open with. A missing field is left out.
 * A blank prompt and an entity that is not an entity reference are left out
 * by `launchContextOf`.
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
 * The prompt and the entity a launch actually carries. The prompt is trimmed.
 * An entity that fails `isEntityRef` from the common package is absent.
 *
 * @public
 */
export interface LaunchContext {
  prompt?: string;
  entityRef?: string;
}

/**
 * The prompt and the entity to keep from a launch. A prompt that is empty
 * after trimming is not a prompt. The text that is sent is the trimmed one.
 * An entity reference that fails the catalog check is dropped.
 *
 * @public
 */
export function launchContextOf(
  request: AiChatLaunchRequest = {},
): LaunchContext {
  const prompt = request.prompt?.trim();
  const entityRef = request.entityRef;
  return {
    ...(prompt ? { prompt } : {}),
    ...(entityRef && isEntityRef(entityRef) ? { entityRef } : {}),
  };
}

/**
 * The page of a message sent from the panel. A launched entity wins over the
 * entity on the page. Without one, the page's own context is used. The path
 * is the path of the page at the moment of sending.
 *
 * @public
 */
export function panelMessagePage(
  launch: LaunchContext | undefined,
  live: ChatPageContext,
): ChatPageContext {
  const entityRef = launch?.entityRef ?? live.entityRef;
  return {
    path: live.path,
    ...(entityRef ? { entityRef } : {}),
  };
}

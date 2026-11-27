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
import type { AiChatLaunchRequest } from '@kwkevinchan/backstage-plugin-ai-chat-react';

/**
 * The prompt and the entity a launch actually carries. The prompt is trimmed.
 * An entity that fails `isEntityRef` from the common package is absent.
 */
export interface LaunchContext {
  /** Sent at once as the first message of a new conversation. */
  prompt?: string;
  /**
   * The prompt of a launch that carries references. It waits in the input of
   * a new conversation, so the user sees the references before sending.
   */
  draft?: string;
  entityRef?: string;
}

/**
 * The prompt and the entity to keep from a launch. A prompt that is empty
 * after trimming is not a prompt. The text that is sent is the trimmed one.
 * With references, the prompt is a draft and is not sent.
 * An entity reference that fails the catalog check is dropped.
 */
export function launchContextOf(
  request: AiChatLaunchRequest = {},
): LaunchContext {
  const prompt = request.prompt?.trim();
  const entityRef = request.entityRef;
  const waits =
    Array.isArray(request.references) && request.references.length > 0;
  const text = waits ? { draft: prompt } : { prompt };
  return {
    ...(prompt ? text : {}),
    ...(entityRef && isEntityRef(entityRef) ? { entityRef } : {}),
  };
}

/**
 * The page of a message sent from the panel. A launched entity wins over the
 * entity on the page. Without one, the page's own context is used. The path
 * is the path of the page at the moment of sending.
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

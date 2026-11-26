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
 * Where a call of an action is, as a result component sees it.
 *
 * - `running`: the call runs, or it was allowed and has no result yet.
 * - `complete`: the call returned `output`.
 * - `failed`: the call failed with `errorText`.
 * - `denied`: the user or a rule did not let the call run.
 * - `unknown`: the call may have run, but its result was not stored.
 *
 * @public
 */
export type AiChatToolResultStatus =
  | 'running'
  | 'complete'
  | 'failed'
  | 'denied'
  | 'unknown';

/**
 * What a result component receives for one call of its action.
 *
 * Every field comes from the model or from the action, so it is untrusted
 * data: never pass it to `dangerouslySetInnerHTML`, and link only `http:`,
 * `https:` and `mailto:` addresses (`AiChatSafeLink` does this).
 *
 * @public
 */
export interface AiChatToolResultProps {
  /** The id of the action, such as `catalog:get-catalog-entity`. */
  actionId: string;
  /** The input of the call, as the model wrote it. */
  input: unknown;
  /** Where the call is: running, complete, failed, denied or unknown. */
  status: AiChatToolResultStatus;
  /**
   * The output of the action, set when `status` is `complete`. An output
   * longer than the limit of the backend is replaced by
   * `{ text, originalLength }`: the first part of its JSON and the full
   * length. A field that the administrator hides arrives as the string
   * `[redacted]`. Handle any shape you do not expect.
   */
  output?: unknown;
  /** Why the call failed, set when `status` is `failed` or `unknown`. */
  errorText?: string;
}

/**
 * A result component for one action. The chat shows it under its own row of
 * the call, which keeps the status, the title and the raw input and output.
 * The component does not replace the approval card.
 *
 * @public
 */
export interface AiChatToolResult {
  /** The id of the action, such as `catalog:get-catalog-entity`. */
  actionId: string;
  /** The component that shows a call of the action. */
  component: ComponentType<AiChatToolResultProps>;
}

/**
 * The result components of the chat, by action id.
 *
 * The chat plugin implements this API. On the new frontend system a plugin
 * adds a component with `AiChatToolResultBlueprint` from the `/alpha` entry
 * point. On the legacy frontend system the app replaces the API with one made
 * by `createAiChatToolResultsApi` of the chat plugin.
 *
 * @public
 */
export interface AiChatToolResultsApi {
  /** The component registered for the action, if there is one. */
  getComponent(
    actionId: string,
  ): ComponentType<AiChatToolResultProps> | undefined;
}

/**
 * The API reference of the result components of the chat.
 *
 * @public
 */
export const aiChatToolResultsApiRef = createApiRef<AiChatToolResultsApi>({
  id: 'plugin.ai-chat.tool-results',
});

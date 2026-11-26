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
 * Entry points another frontend plugin uses with the AI chat: the panel
 * Utility API reference, a button that carries a prompt and an entity
 * reference, a hook for the side panel, and the types of a result component
 * for an action with a link that keeps only safe addresses. The chat plugin
 * implements both APIs and renders the panel. The blueprint that adds a result
 * component on the new frontend system is in the `/alpha` entry point. This
 * package does not register a client tool.
 *
 * @packageDocumentation
 */

export {
  aiChatPanelApiRef,
  type AiChatLaunchRequest,
  type AiChatPanelApi,
} from './api';
export { useAiChatPanel } from './application/useAiChatPanel';
export { AiChatLauncher, type AiChatLauncherProps } from './ui/AiChatLauncher';
export {
  aiChatToolResultsApiRef,
  type AiChatToolResult,
  type AiChatToolResultProps,
  type AiChatToolResultsApi,
  type AiChatToolResultStatus,
} from './toolResults';
export {
  AiChatSafeLink,
  isSafeLinkHref,
  type AiChatSafeLinkProps,
} from './ui/AiChatSafeLink';

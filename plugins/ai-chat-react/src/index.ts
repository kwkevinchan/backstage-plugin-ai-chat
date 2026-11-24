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
 * Entry points another frontend plugin uses to open the AI chat: a button
 * that carries a prompt and an entity reference, and a hook for the side
 * panel. The chat plugin renders the panel. This package does not render a
 * result and does not register a client tool.
 *
 * @packageDocumentation
 */

export {
  launchContextOf,
  panelMessagePage,
  type AiChatLaunchRequest,
  type LaunchContext,
} from './domain/launch';
export type { PanelState } from './domain/panel';
export {
  createAiChatPanelStore,
  type AiChatPanelStore,
} from './application/panelStore';
export {
  AiChatPanelProvider,
  useAiChatPanel,
  useAiChatPanelStore,
  type AiChatPanelController,
} from './application/useAiChatPanel';
export { AiChatLauncher, type AiChatLauncherProps } from './ui/AiChatLauncher';

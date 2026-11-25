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
 * Extension point for backend modules of the AI chat. The types are defined
 * in the harness and re-exported here, so a module does not import the
 * harness or the backend plugin.
 *
 * This version exposes `addAgent` and `addHook`. Context providers, skills and
 * a model client are added on later items, together with the loop calling
 * them.
 *
 * @packageDocumentation
 */

export { aiChatHarnessExtensionPoint } from './extensionPoint';

export type {
  AgentDefinition,
  AgentLimits,
  AiChatHarnessExtensionPoint,
  BeforeToolCallDecision,
  HookName,
  Hooks,
  PlanningMode,
  RunSummary,
  StepContext,
  ToolCall,
  ToolResult,
} from '@kwkevinchan/ai-chat-harness';

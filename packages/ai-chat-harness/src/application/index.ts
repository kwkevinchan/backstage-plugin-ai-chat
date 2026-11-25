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

export { AdvanceRun } from './AdvanceRun';
export type { AdvanceRunDeps, AdvanceRunRequest } from './types';
export type { HarnessEvent, RunOutcome } from './events';
export type { Clock } from './ports/Clock';
export {
  emptyExtensions,
  type AiChatHarnessExtensionPoint,
  type Extensions,
} from './ports/extensions';
export type { IdGenerator } from './ports/IdGenerator';
export type { ItemDraft, ItemLog, RunFence } from './ports/ItemLog';
export type { ModelChunk, ModelClient } from './ports/ModelClient';
export type { RunControl } from './ports/RunControl';
export type {
  CallContext,
  ToolGateway,
  ToolOutput,
  ValidationResult,
} from './ports/ToolGateway';

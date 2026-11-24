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

export { callsAwaitingDecision, findToolCall, hasResult } from './approval';
export {
  AgentNotFound,
  ChatDomainError,
  InsertLimitReached,
  NoActiveRun,
  NotSessionOwner,
  QueueChanged,
  QueuedMessageNotFound,
  QueueFull,
  RunAlreadyActive,
  RunNotFound,
  RunNotRunning,
  RunNotWaiting,
  SessionNotFound,
  ShuttingDown,
  ToolCallNotFound,
  ToolCallNotWaiting,
  UnknownToolset,
  UnreadMessages,
} from './errors';
export type { Principal } from './principal';
export {
  canAutoStart,
  DEFAULT_INSERT_MAX_PER_RUN,
  DEFAULT_QUEUE_MAX_MESSAGES,
  isNormalEnd,
  type PausedReason,
  type QueuedMessage,
} from './queue';
export { CREDENTIALS_MARGIN_SECONDS, runLimits } from './runLimits';
export type { LeasedRun, Run } from './run';
export { assertOwner } from './session';
export type { NewSession, Session, SessionPatch } from './session';
export { buildSystemPrompt } from './systemPrompt';
export {
  defaultToolsetIds,
  enabledTools,
  isEgress,
  matchesActionPattern,
  toolsetsOf,
  unsafeAllows,
} from './toolset';
export type { Toolset } from './toolset';

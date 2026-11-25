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

export {
  ATTACHMENT_TTL_HOURS,
  checkImage,
  cleanAttachmentName,
  DEFAULT_IMAGE_LIMITS,
  IMAGE_MEDIA_TYPES,
  isImageMediaType,
  type AttachmentMeta,
  type ImageLimits,
  type ImageMediaType,
} from './attachment';
export { callsAwaitingDecision, findToolCall, hasResult } from './approval';
export {
  AgentNotFound,
  AttachmentNotFound,
  AttachmentTooLarge,
  ChatDomainError,
  EmptyMessage,
  ImagesNotSupported,
  InsertLimitReached,
  InvalidAttachment,
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
  TooManyAttachments,
  TooManyImageBytes,
  TooManyPendingAttachments,
  ToolCallNotFound,
  ToolCallNotWaiting,
  UnknownAttachment,
  UnknownToolset,
  UnsupportedAttachmentType,
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
export {
  DEFAULT_RETENTION_DAYS,
  isSessionExpired,
  sessionRetentionCutoff,
} from './retention';
export { allowsSessionRead, shareGrantsRead, shareScope } from './share';
export type { NewShare, Share, ShareScope, ShareScopeInput } from './share';
export { assertOwner, isSessionOwner } from './session';
export type { NewSession, Session, SessionPatch } from './session';
export {
  GENERATED_TITLE_MAX_CHARS,
  TITLE_SOURCE_MAX_CHARS,
  conversationForTitle,
  normalizeSearchQuery,
  searchLikePattern,
  shouldAutoTitle,
  titleFromModelAnswer,
} from './sessionList';
export {
  NOT_SHARED_OUTPUT,
  effectiveShare,
  visibleItems,
  visibleSeqLimit,
} from './visibility';
export type { VisibleItem } from './visibility';
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

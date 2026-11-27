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
  ConflictError,
  CustomErrorBase,
  InputError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
import { InvalidRunTransition, LeaseLost } from '@kwkevinchan/ai-chat-harness';
import {
  AgentNotFound,
  AttachmentInUse,
  AttachmentNotFound,
  AttachmentTooLarge,
  EmptyMessage,
  ImagesNotSupported,
  InsertLimitReached,
  InvalidAttachment,
  InvalidShare,
  LiveSharingDisabled,
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
  ShareNotFound,
  ShuttingDown,
  TooManyAttachments,
  TooManyImageBytes,
  TooManyPendingAttachments,
  ToolCallNotFound,
  ToolCallNotWaiting,
  TooManyActiveRuns,
  UnknownAttachment,
  UnknownEntity,
  UnknownToolset,
  UnsupportedAttachmentType,
} from '../../domain';

/**
 * An error whose `name` is the name of the domain error, so a screen can tell
 * apart the errors that share a status code (`QueueFull` and `QueueChanged`
 * are both 409). The status is set on the error: the error handler of Backstage
 * reads it from there, and from the name only for its own error classes.
 */
class NamedHttpError extends CustomErrorBase {
  readonly statusCode: number;

  constructor(name: string, statusCode: number, message: string) {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
  }
}

/**
 * The error of a use case as the error that Backstage answers with.
 *
 * - Not found, and not the owner: 404, with the same text. Another user's
 *   session looks like a session that does not exist.
 * - A run is active, or a call or a run is not in the state the request needs:
 *   409. The errors of the input phase (a message that cannot be inserted or
 *   queued, a queue that changed) keep their own name in `error.name`.
 * - The errors of an image: the type is not supported 415, the image is too
 *   large 413, the content or the name is not usable 400, the session has
 *   too many images in no message 409, and a message that names an image of
 *   another session 400 (`AttachmentNotFound`); the image itself, when read
 *   by its id, is 404. A message with too many images, with images for a model
 *   that cannot read them, or with more image bytes than the run may have: 400.
 * - A toolset or an agent that the request names and does not exist: 400.
 * - The user has as many runs going on as `aiChat.runsPerUser` allows: 429,
 *   with `TooManyActiveRuns` in `error.name`.
 * - The backend is shutting down: 503.
 * - The run was taken over or ended by someone else in the meantime
 *   (`LeaseLost`, `InvalidRunTransition`): 409.
 * - An error of Backstage (such as the 400 of a bad body) stays as it is.
 * - Any other error is returned unchanged so Backstage's default error handler
 *   logs the original message and stack and filters internal errors such as
 *   `DatabaseError` from the response.
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof NotSessionOwner) {
    return new NotFoundError(new SessionNotFound(error.sessionId).message);
  }
  if (
    error instanceof SessionNotFound ||
    error instanceof RunNotFound ||
    error instanceof ToolCallNotFound
  ) {
    return new NotFoundError(error.message);
  }
  if (
    error instanceof RunAlreadyActive ||
    error instanceof RunNotWaiting ||
    error instanceof ToolCallNotWaiting
  ) {
    return new ConflictError(error.message);
  }
  if (error instanceof RunNotRunning || error instanceof InsertLimitReached) {
    return new NamedHttpError(error.name, 409, error.message);
  }
  if (
    error instanceof NoActiveRun ||
    error instanceof QueueFull ||
    error instanceof QueueChanged
  ) {
    return new NamedHttpError(error.name, 409, error.message);
  }
  if (error instanceof TooManyActiveRuns) {
    return new NamedHttpError(error.name, 429, error.message);
  }
  if (error instanceof ShareNotFound) {
    return new NamedHttpError(error.name, 404, error.message);
  }
  if (error instanceof InvalidShare || error instanceof LiveSharingDisabled) {
    return new NamedHttpError(error.name, 400, error.message);
  }
  if (error instanceof QueuedMessageNotFound) {
    return new NamedHttpError(error.name, 404, error.message);
  }
  if (error instanceof UnsupportedAttachmentType) {
    return new NamedHttpError(error.name, 415, error.message);
  }
  if (error instanceof AttachmentTooLarge) {
    return new NamedHttpError(error.name, 413, error.message);
  }
  if (
    error instanceof InvalidAttachment ||
    error instanceof TooManyAttachments ||
    error instanceof ImagesNotSupported ||
    error instanceof TooManyImageBytes ||
    error instanceof EmptyMessage
  ) {
    return new NamedHttpError(error.name, 400, error.message);
  }
  if (error instanceof UnknownAttachment) {
    return new NamedHttpError('AttachmentNotFound', 400, error.message);
  }
  if (error instanceof AttachmentNotFound) {
    return new NamedHttpError(error.name, 404, error.message);
  }
  if (
    error instanceof TooManyPendingAttachments ||
    error instanceof AttachmentInUse
  ) {
    return new NamedHttpError(error.name, 409, error.message);
  }
  if (
    error instanceof UnknownToolset ||
    error instanceof AgentNotFound ||
    error instanceof UnknownEntity
  ) {
    return new InputError(error.message);
  }
  if (error instanceof ShuttingDown) {
    return new ServiceUnavailableError(error.message);
  }
  if (error instanceof LeaseLost || error instanceof InvalidRunTransition) {
    return new ConflictError('The run changed in the meantime. Try again.');
  }
  if (error instanceof CustomErrorBase) return error;
  return error;
}

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
  NotSessionOwner,
  RunAlreadyActive,
  RunNotFound,
  RunNotWaiting,
  SessionNotFound,
  ShuttingDown,
  ToolCallNotFound,
  ToolCallNotWaiting,
  UnknownToolset,
} from '../../domain';

const UNEXPECTED_TEXT = 'The request failed.';

/**
 * The error of a use case as the error that Backstage answers with.
 *
 * - Not found, and not the owner: 404, with the same text. Another user's
 *   session looks like a session that does not exist.
 * - A run is active, or a call or a run is not in the state the request needs:
 *   409.
 * - A toolset or an agent that the request names and does not exist: 400.
 * - The backend is shutting down: 503.
 * - The run was taken over or ended by someone else in the meantime
 *   (`LeaseLost`, `InvalidRunTransition`): 409.
 * - An error of Backstage (such as the 400 of a bad body) stays as it is.
 * - Any other error is unexpected. The error handler of Backstage sends the
 *   name and the message of such an error to the client (the message of a
 *   database error can have the SQL), so `onUnexpected` gets the error for the
 *   log, and the answer is a 500 with a fixed text.
 */
export function toHttpError(
  error: unknown,
  onUnexpected: (error: unknown) => void,
): Error {
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
  if (error instanceof UnknownToolset || error instanceof AgentNotFound) {
    return new InputError(error.message);
  }
  if (error instanceof ShuttingDown) {
    return new ServiceUnavailableError(error.message);
  }
  if (error instanceof LeaseLost || error instanceof InvalidRunTransition) {
    return new ConflictError('The run changed in the meantime. Try again.');
  }
  if (error instanceof CustomErrorBase) return error;
  onUnexpected(error);
  return new Error(UNEXPECTED_TEXT);
}

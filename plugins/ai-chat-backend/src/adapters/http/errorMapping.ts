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
  InputError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
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

/**
 * The error of a use case as the error that Backstage answers with.
 *
 * - Not found, and not the owner: 404, with the same text. Another user's
 *   session looks like a session that does not exist.
 * - A run is active, or a call or a run is not in the state the request needs:
 *   409.
 * - A toolset or an agent that the request names and does not exist: 400.
 * - The backend is shutting down: 503.
 *
 * Any other error is returned as it is, and the error handler of the backend
 * answers 500 without its text.
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
  if (error instanceof UnknownToolset || error instanceof AgentNotFound) {
    return new InputError(error.message);
  }
  if (error instanceof ShuttingDown) {
    return new ServiceUnavailableError(error.message);
  }
  return error;
}

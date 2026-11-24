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

/** Base class of the errors of the host. `code` tells the kinds apart without `instanceof`. */
export class ChatDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** There is no session with this id. */
export class SessionNotFound extends ChatDomainError {
  constructor(sessionId: string) {
    super('SESSION_NOT_FOUND', `There is no session ${sessionId}`);
  }
}

/** There is no run with this id. */
export class RunNotFound extends ChatDomainError {
  constructor(runId: string) {
    super('RUN_NOT_FOUND', `There is no run ${runId}`);
  }
}

/** The session has a run that has not ended (H-03). */
export class RunAlreadyActive extends ChatDomainError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      'RUN_ALREADY_ACTIVE',
      `Session ${sessionId} already has a run that has not ended`,
    );
    this.sessionId = sessionId;
  }
}

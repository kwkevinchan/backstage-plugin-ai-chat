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

/** The caller is not the owner of the session. */
export class NotSessionOwner extends ChatDomainError {
  constructor(sessionId: string) {
    super('NOT_SESSION_OWNER', `Not the owner of session ${sessionId}`);
  }
}

/** The session has no tool call with this id. */
export class ToolCallNotFound extends ChatDomainError {
  constructor(callId: string) {
    super('TOOL_CALL_NOT_FOUND', `There is no tool call ${callId}`);
  }
}

/** The tool call does not wait for a decision: it has a result, or needs none. */
export class ToolCallNotWaiting extends ChatDomainError {
  constructor(callId: string) {
    super(
      'TOOL_CALL_NOT_WAITING',
      `Tool call ${callId} does not wait for a decision`,
    );
  }
}

/** The run does not wait for an approval (any more). */
export class RunNotWaiting extends ChatDomainError {
  constructor(runId: string) {
    super('RUN_NOT_WAITING', `Run ${runId} does not wait for an approval`);
  }
}

/** There is no agent with this id. */
export class AgentNotFound extends ChatDomainError {
  constructor(agentId: string) {
    super('AGENT_NOT_FOUND', `There is no agent ${agentId}`);
  }
}

/** A toolset id that the administrator did not define (T-11). */
export class UnknownToolset extends ChatDomainError {
  constructor(toolsetId: string) {
    super('UNKNOWN_TOOLSET', `There is no toolset ${toolsetId}`);
  }
}

/** This backend is shutting down and takes no new runs (H-11). */
export class ShuttingDown extends ChatDomainError {
  constructor() {
    super('SHUTTING_DOWN', 'The backend is shutting down');
  }
}

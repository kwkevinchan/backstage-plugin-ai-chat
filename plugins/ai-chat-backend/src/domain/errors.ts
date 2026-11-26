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
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('NOT_SESSION_OWNER', `Not the owner of session ${sessionId}`);
    this.sessionId = sessionId;
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

/**
 * The user has `aiChat.runsPerUser` runs going on (`running` or
 * `waiting_approval`) in their sessions, and no other run may start (P-05).
 */
export class TooManyActiveRuns extends ChatDomainError {
  constructor(limit: number) {
    super(
      'TOO_MANY_ACTIVE_RUNS',
      `You have ${limit} runs going on. Wait for one to end, or stop one.`,
    );
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

/**
 * A session cannot be bound to this entity (SE-02): the ref has no kind, the
 * entity does not exist, or the user cannot read it. The message is the same
 * for each, so it does not tell whether the entity exists.
 */
export class UnknownEntity extends ChatDomainError {
  constructor() {
    super(
      'UNKNOWN_ENTITY',
      'entityRef must be the ref of an entity you can read, with its kind',
    );
  }
}

/** This backend is shutting down and takes no new runs (H-11). */
export class ShuttingDown extends ChatDomainError {
  constructor() {
    super('SHUTTING_DOWN', 'The backend is shutting down');
  }
}

/**
 * A message cannot be inserted: the run is not `running` (it waits for an
 * approval or has ended), it is another run than the one the request names, or
 * its lease has expired (IN-11).
 */
export class RunNotRunning extends ChatDomainError {
  constructor(runId: string) {
    super('RUN_NOT_RUNNING', `Run ${runId} does not take inserted messages`);
  }
}

/** The run has taken as many inserted messages as it may (IN-10). */
export class InsertLimitReached extends ChatDomainError {
  constructor(runId: string, max: number) {
    super(
      'INSERT_LIMIT_REACHED',
      `Run ${runId} has taken ${max} inserted messages already`,
    );
  }
}

/**
 * The run cannot end: a message was inserted after the model began its last
 * answer, so the model has not read it (IN-11). The run stays `running`.
 */
export class UnreadMessages extends ChatDomainError {
  constructor(runId: string) {
    super(
      'UNREAD_MESSAGES',
      `Run ${runId} has messages the model did not read`,
    );
  }
}

/** A message cannot be queued: the session has no run that has not ended. */
export class NoActiveRun extends ChatDomainError {
  constructor(sessionId: string) {
    super('NO_ACTIVE_RUN', `Session ${sessionId} has no run to queue behind`);
  }
}

/** The queue of the session is full (IN-13). */
export class QueueFull extends ChatDomainError {
  constructor(sessionId: string, max: number) {
    super(
      'QUEUE_FULL',
      `The queue of session ${sessionId} has ${max} messages`,
    );
  }
}

/** The ids of a reorder are not the ids in the queue: another tab changed it. */
export class QueueChanged extends ChatDomainError {
  constructor(sessionId: string) {
    super('QUEUE_CHANGED', `The queue of session ${sessionId} changed`);
  }
}

/** The queued message is gone: deleted, or already sent. */
export class QueuedMessageNotFound extends ChatDomainError {
  constructor(queuedId: string) {
    super('QUEUED_MESSAGE_NOT_FOUND', `There is no queued message ${queuedId}`);
  }
}

/** The `Content-Type` of an upload is not one of the image types the chat takes (IN-02). */
export class UnsupportedAttachmentType extends ChatDomainError {
  constructor(mediaType: string) {
    super(
      'UNSUPPORTED_ATTACHMENT_TYPE',
      `The type ${
        mediaType || '(none)'
      } is not supported. Use PNG, JPEG, WebP or GIF.`,
    );
  }
}

/** The upload is larger than `maxBytes` (IN-02). */
export class AttachmentTooLarge extends ChatDomainError {
  constructor(maxBytes: number) {
    super('ATTACHMENT_TOO_LARGE', `An image may be at most ${maxBytes} bytes`);
  }
}

/** The upload is empty, its header does not match its type, or its name is not usable (IN-02). */
export class InvalidAttachment extends ChatDomainError {
  constructor(reason: string) {
    super('INVALID_ATTACHMENT', reason);
  }
}

/** The session has as many images in no message as it may (IN-04). */
export class TooManyPendingAttachments extends ChatDomainError {
  constructor(sessionId: string, max: number) {
    super(
      'TOO_MANY_PENDING_ATTACHMENTS',
      `Session ${sessionId} has ${max} images that are in no message yet`,
    );
  }
}

/** There is no attachment with this id in the session. The caller asked for the image itself. */
export class AttachmentNotFound extends ChatDomainError {
  constructor(attachmentId: string) {
    super('ATTACHMENT_NOT_FOUND', `There is no attachment ${attachmentId}`);
  }
}

/**
 * A message names an attachment that is not in its session. The answer is a
 * 400 named `AttachmentNotFound`: the request is wrong, not the path.
 */
export class UnknownAttachment extends ChatDomainError {
  constructor(attachmentId: string) {
    super(
      'UNKNOWN_ATTACHMENT',
      `The message names the attachment ${attachmentId}, which is not in this session`,
    );
  }
}

/** A message has more images than `maxPerMessage` (IN-01). */
export class TooManyAttachments extends ChatDomainError {
  constructor(max: number) {
    super('TOO_MANY_ATTACHMENTS', `A message may have at most ${max} images`);
  }
}

/** The message has images, and the model cannot read images (IN-05). */
export class ImagesNotSupported extends ChatDomainError {
  constructor() {
    super('IMAGES_NOT_SUPPORTED', 'The model cannot read images');
  }
}

/** The images of the messages of the run, with this one, are over `maxBytesPerInput` (IN-06). */
export class TooManyImageBytes extends ChatDomainError {
  constructor(runId: string, max: number) {
    super(
      'TOO_MANY_IMAGE_BYTES',
      `The messages of run ${runId} may have ${max} bytes of images in all`,
    );
  }
}

/** The message would have no text and no image (IN-09). */
export class EmptyMessage extends ChatDomainError {
  constructor() {
    super('EMPTY_MESSAGE', 'must have text or at least one image');
  }
}

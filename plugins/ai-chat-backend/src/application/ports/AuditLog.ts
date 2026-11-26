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
 * What the audit log records about a tool call (O-02): the decision of the
 * user, and the run of a tool that is not read-only.
 */
export type ToolAuditEvent = {
  eventId: 'tool-call-approve' | 'tool-call-deny' | 'tool-call-invoke';
  /** The entity ref of the user the event is for. */
  actorRef: string;
  sessionId: string;
  runId: string;
  callId: string;
  toolId: string;
  readOnly: boolean;
};

/**
 * A queued message that starts a run (IN-17). No HTTP request of the user
 * makes it (the queue sends it when the run before it ended), so the event says
 * whose message it is.
 */
export type QueueAuditEvent = {
  eventId: 'queued-message-send';
  /** The entity ref of the user the event is for. */
  actorRef: string;
  sessionId: string;
  /** The run the message started. */
  runId: string;
  queuedMessageId: string;
};

/**
 * A change of a share (SH-06). The fields are the share as it is after the
 * change; an absent seq or `expiresAt` is one the share does not have.
 */
export type ShareAuditEvent = {
  eventId: 'session-share' | 'session-share-update' | 'session-share-revoke';
  /** The entity ref of the user who made the change. */
  actorRef: string;
  sessionId: string;
  shareId: string;
  subjectRef: string;
  mode: 'snapshot' | 'live';
  upToSeq?: number;
  outputsUpToSeq?: number;
  /** ISO 8601. */
  expiresAt?: string;
};

export type AuditEvent = ToolAuditEvent | QueueAuditEvent | ShareAuditEvent;

/** An event that has begun; end it with `success` or `fail`. */
export interface AuditSpan {
  success(): Promise<void>;
  /** `message` is for the log of the auditor; keep secrets out of it. */
  fail(message: string): Promise<void>;
}

/** Where the audit events go. */
export interface AuditLog {
  begin(event: AuditEvent): Promise<AuditSpan>;
}

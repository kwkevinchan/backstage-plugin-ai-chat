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

import type { JsonObject, JsonValue } from '@backstage/types';

/**
 * Where a run is in its life. A run that has not ended is `running` or
 * `waiting_approval`.
 *
 * @public
 */
export type ChatRunStatus =
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** A session: one conversation of one owner. @public */
export interface ChatSession {
  id: string;
  ownerRef: string;
  agentId: string;
  title?: string;
  /**
   * The entity the session is bound to (`kind:namespace/name`, lower case):
   * the one it was created with, or the entity of the page of its first
   * message. It does not change.
   */
  entityRef?: string;
  /** The ids of the toolsets that are switched on in this session. */
  enabledToolsets: string[];
  pinned: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when a run of the session has not ended: the loop is working, or it
   * waits for an approval. Absent when there is no such run.
   */
  activity?: 'running' | 'waiting_approval';
}

/** A run: one pass of the agent loop over a message of the user. @public */
export interface ChatRun {
  id: string;
  sessionId: string;
  status: ChatRunStatus;
  cancelRequested: boolean;
  /** Why the run ended, for a run that ended. */
  endReason?: string;
  startedAt: string;
  endedAt?: string;
}

/** @public */
export type ChatToolResultStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'denied'
  | 'invalid'
  | 'unknown';

/**
 * Fixed reason code explaining why a tool call received `status: 'denied'`.
 *
 * @public
 */
export type ChatToolDeniedReason =
  | 'policy'
  | 'run_limit'
  | 'step_limit'
  | 'hook'
  | 'user'
  | 'earlier_write_timed_out';

/** @public */
export type ChatPlanItemStatus = 'pending' | 'in_progress' | 'completed';

/** The plan of the agent; an update replaces the whole plan. @public */
export interface ChatPlan {
  items: { text: string; status: ChatPlanItemStatus }[];
}

/**
 * How a message of the user reached the run: written by the user as the first
 * message of the run (`direct`), added to a run that was going on
 * (`inserted`), or sent from the queue when the run before it ended
 * (`queued`). A message with no value is `direct`.
 *
 * @public
 */
export type ChatDelivery = 'direct' | 'inserted' | 'queued';

/**
 * Whether the model read an inserted message: `read`; `pending` (not read
 * yet, and the run goes on); `unread` (the run ended without reading it).
 *
 * @public
 */
export type ChatInsertState = 'read' | 'pending' | 'unread';

/**
 * An image of a message: what the screen needs to draw it. The bytes are read
 * with `GET /sessions/:id/attachments/:attachmentId`.
 *
 * @public
 */
export interface ChatAttachment {
  id: string;
  mediaType: string;
  name: string;
  /** Size in bytes. */
  size: number;
}

/** The answer of `POST /sessions/:id/attachments`. @public */
export interface ChatUploadedAttachment {
  id: string;
  mediaType: string;
  name: string;
  size: number;
}

/**
 * The answer of `GET /input-config`: what a message may carry, so the screen
 * checks an image before it uploads it.
 *
 * @public
 */
export interface ChatInputConfig {
  images: {
    /** Whether the model reads images. The screen shows no attach button when it does not. */
    enabled: boolean;
    /** The media types the upload takes. */
    mediaTypes: string[];
    /** Most images in one message. */
    maxPerMessage: number;
    /** Largest image, in bytes. */
    maxBytes: number;
    /** Most image bytes in the messages of one run. */
    maxBytesPerInput: number;
    /** Most images of a session that are in no message yet. */
    maxPendingPerSession: number;
  };
  /** Most messages inserted into one run. */
  insertMaxPerRun: number;
  /** Most messages in the queue of one session. */
  queueMaxMessages: number;
}

/** @public */
export type ChatItemBody =
  | {
      kind: 'user_message';
      text: string;
      /** The images of the message, in the order the user gave them. */
      attachments?: ChatAttachment[];
      page?: ChatPageContext;
      delivery?: ChatDelivery;
      /**
       * Only in the answer of `GET /sessions/:id`, and only on an inserted
       * message.
       */
      insertState?: ChatInsertState;
    }
  | {
      kind: 'agent_message';
      text: string;
      /**
       * The largest `seq` the model had read when it began this answer. An
       * inserted message with a `seq` up to it was read by this answer.
       */
      readUpToSeq?: number;
    }
  | {
      kind: 'tool_call';
      callId: string;
      /** The id of the action in the actions registry. */
      toolId: string;
      /** The exact input that runs when the call is allowed. */
      input: JsonObject;
      schemaHash: string;
      policy: 'allow' | 'ask';
      readOnly: boolean;
      step: number;
      position: number;
      /** See `agent_message`. */
      readUpToSeq?: number;
    }
  | {
      kind: 'approval';
      callId: string;
      decision: 'allow' | 'deny';
      decidedBy: string;
    }
  | { kind: 'tool_started'; callId: string }
  | {
      kind: 'tool_result';
      callId: string;
      status: ChatToolResultStatus;
      deniedReason?: ChatToolDeniedReason;
      output?: JsonValue;
      truncated?: boolean;
      message?: string;
    }
  | { kind: 'plan_update'; plan: ChatPlan }
  | { kind: 'summary'; coversUpToSeq: number; text: string }
  | { kind: 'note'; text: string };

/** @public */
export type ChatItemKind = ChatItemBody['kind'];

/**
 * One entry of the log of a session. `seq` grows by one with each item of
 * the session. A `summary` item is for the model, not for the screen.
 *
 * @public
 */
export type ChatItem = ChatItemBody & {
  sessionId: string;
  seq: number;
  runId?: string;
  createdAt: string;
};

/** The answer of `GET /sessions`. @public */
export interface ChatSessionList {
  items: ChatSession[];
}

/**
 * Present on `GET /sessions/:id` when the caller reads someone else's session
 * through a share (SH-12). Absent for the owner.
 *
 * @public
 */
export interface ChatSharedView {
  /** `snapshot` when frozen at a point in time (including an expired live share), `live` when following new items. */
  mode: ChatShareMode;
  /** When `mode` is `snapshot`: the timestamp of the snapshot or expiry, ISO 8601. */
  snapshotAt?: string;
  /** When `mode` is `live`: when the live share expires, ISO 8601. */
  expiresAt?: string;
}

/**
 * The answer of `GET /sessions/:id`.
 *
 * @public
 */
export interface ChatSessionDetail {
  session: ChatSession;
  /** The run that has not ended, if there is one. */
  run?: ChatRun;
  items: ChatItem[];
  /**
   * The ids of the tool calls that wait for a decision of the user. Not
   * limited by `afterSeq`. Empty unless the run waits for an approval.
   */
  awaitingDecision: string[];
  /**
   * The run waits for an approval and no call is left to decide: the loop did
   * not start after the last decision. `POST /sessions/:id/resume` carries it
   * on.
   */
  resumable: boolean;
  /** The messages that wait for the run to end, and whether the queue waits for the user. */
  queue: ChatQueue;
  /** Present when the caller is a sharee rather than the owner (SH-12). */
  shared?: ChatSharedView;
}

/** A message that waits for the run of the session to end. @public */
export interface ChatQueuedMessage {
  id: string;
  /** From 1, in the order the messages are sent. */
  position: number;
  text: string;
  /** The images of the message; the queue holds them until it is sent. */
  attachments?: ChatAttachment[];
  page?: ChatPageContext;
  createdAt: string;
  updatedAt: string;
}

/**
 * The queue of a session. It is `paused` when no run goes on and the queue is
 * not empty: nothing is sent until the user continues it.
 *
 * @public
 */
export interface ChatQueue {
  items: ChatQueuedMessage[];
  paused: boolean;
}

/** The page the user is on; the model gets it with the message. @public */
export interface ChatPageContext {
  path: string;
  entityRef?: string;
}

/**
 * `snapshot`: the sharee sees the session up to the moment of the share, or
 * of the last refresh. `live`: the sharee sees what comes next too, until the
 * share expires.
 *
 * @public
 */
export type ChatShareMode = 'snapshot' | 'live';

/**
 * A read-only share of a session, as its owner sees it.
 *
 * @public
 */
export interface ChatShare {
  id: string;
  /** `user:<namespace>/<name>` or `group:<namespace>/<name>`. */
  subjectRef: string;
  mode: ChatShareMode;
  /** Snapshot: the last `seq` the sharee sees. */
  upToSeq?: number;
  /**
   * The last `seq` whose tool output the sharee sees; past it a tool result
   * is a status only. `0` hides every output; absent shows every output in
   * the range.
   */
  outputsUpToSeq?: number;
  /** Live: when the share stops updating (ISO 8601). */
  expiresAt?: string;
  /** Live and past `expiresAt`: the sharee sees the session as it was then. */
  expired: boolean;
  createdBy: string;
  createdAt: string;
}

/** The answer of `GET /sessions/:id/shares`: the shares that are not cancelled, oldest first. @public */
export interface ChatShareList {
  items: ChatShare[];
}

/**
 * The body of `POST /sessions/:id/shares`.
 *
 * @public
 */
export interface CreateChatShareRequest {
  subjectRef: string;
  /** `snapshot` by default. */
  mode?: ChatShareMode;
  /** True by default. False: the sharee sees no tool output. */
  includeToolOutputs?: boolean;
  /** Live only. True: tool output written after the share is shown too. */
  includeLaterToolOutputs?: boolean;
  /** Live only: hours until the share expires. The default and the maximum are set by the administrator. */
  hours?: number;
}

/**
 * The body of `PATCH /sessions/:id/shares/:shareId`. At least one field.
 *
 * @public
 */
export interface UpdateChatShareRequest {
  /** Snapshot only: the sharee sees the session up to now. */
  refresh?: true;
  includeToolOutputs?: boolean;
  /** Live only. */
  includeLaterToolOutputs?: boolean;
  /** Live only: the share expires this many hours from now. */
  hours?: number;
}

/** The body of `POST /sessions`. @public */
export interface CreateChatSessionRequest {
  agentId?: string;
  title?: string;
  entityRef?: string;
  enabledToolsets?: string[];
}

/** The body of `PATCH /sessions/:id`. `null` as the title removes it. @public */
export interface UpdateChatSessionRequest {
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
  enabledToolsets?: string[];
}

/** The body of `POST /sessions/:id/runs`. @public */
export interface SendChatMessageRequest {
  text: string;
  /** Ids of uploaded images of this session. */
  attachmentIds?: string[];
  page?: ChatPageContext;
}

/** The body of `POST /sessions/:id/runs/:runId/messages`. @public */
export interface InsertChatMessageRequest {
  text: string;
  /** Ids of uploaded images of this session. */
  attachmentIds?: string[];
  page?: ChatPageContext;
}

/** The body of `POST /sessions/:id/queue`. @public */
export interface QueueChatMessageRequest {
  text: string;
  /** Ids of uploaded images of this session. */
  attachmentIds?: string[];
  page?: ChatPageContext;
}

/** The body of `PATCH /sessions/:id/queue/:queuedId`. `null` as the page removes it. @public */
export interface UpdateQueuedMessageRequest {
  text?: string;
  /** The ids of all the images the message keeps. */
  attachmentIds?: string[];
  page?: ChatPageContext | null;
}

/** The body of `PUT /sessions/:id/queue/order`: every id of the queue, in the new order. @public */
export interface ReorderQueueRequest {
  ids: string[];
}

/** The body of `POST /sessions/:id/queue/:queuedId/insert`. @public */
export interface InsertQueuedMessageRequest {
  runId: string;
}

/** The body of `POST /sessions/:id/tool-calls/:callId/decision`. @public */
export interface DecideToolCallRequest {
  approved: boolean;
  page?: ChatPageContext;
}

/** The body of `POST /sessions/:id/resume`. @public */
export interface ResumeChatRunRequest {
  page?: ChatPageContext;
}

/**
 * The JSON answer of the decision route, when the response is not a stream:
 * other calls still wait for a decision, or another request carries the run
 * on. `approved` is the decision that stands; for a call that had been
 * decided already, that is the earlier decision, not the one of the request.
 *
 * @public
 */
export interface ChatDecisionResponse {
  approved: boolean;
}

/** A toolset the user can switch on or off in a session. @public */
export interface ChatToolset {
  id: string;
  title?: string;
  /** Whether a new session has it switched on. */
  default: boolean;
  /** Whether its tools send data out of the organization. */
  egress: boolean;
}

/** A tool that a session offers to the model, as the screen shows a call. @public */
export interface ChatTool {
  /** The id of the action in the actions registry; the name of a call. */
  id: string;
  title?: string;
  /** What the tool does. */
  description: string;
  /** Whether the tool only reads. Any other tool asks for approval. */
  readOnly: boolean;
}

/** The answer of `GET /sessions/:id/tools`. @public */
export interface ChatToolList {
  items: ChatTool[];
}

/** The answer of `GET /toolsets`. @public */
export interface ChatToolsetList {
  items: ChatToolset[];
}

/**
 * The data of the `data-run` part of the response stream (transient): the
 * state of the run at that point of the stream. It comes before the end of the
 * stream (`finish`, `error` or `abort`), so a client that stops reading at an
 * `error` has it already.
 *
 * @public
 */
export interface ChatRunData {
  runId: string;
  status: ChatRunStatus;
  endReason?: string;
}

/**
 * The data of the `data-item` part of the response stream (transient): an
 * item was written to the log. A client that follows a stream keeps the
 * highest `seq`.
 *
 * @public
 */
export interface ChatItemData {
  seq: number;
  kind: ChatItemKind;
}

/**
 * The data of the `data-notice` part of the response stream (transient): a
 * short note for the screen. `code` is for a client that translates the text.
 *
 * - `summarizing`: the older part of the conversation is being summarized.
 * - `context_trimmed`: older content was left out of what the model reads.
 *   Sent at most once in a stream.
 *
 * @public
 */
export interface ChatNoticeData {
  code: 'summarizing' | 'context_trimmed';
  text: string;
}

/**
 * The data of the `data-inserted` part of the response stream: the model read
 * a message that was inserted into the run. The part comes before the step
 * that read it, and goes into the message. It has the id `inserted-<seq>`, so
 * a client that gets it twice keeps one.
 *
 * @public
 */
export interface ChatInsertedData {
  seq: number;
  text: string;
  attachments?: ChatAttachment[];
  page?: ChatPageContext;
}

/** Why a queue does not send its next message by itself. @public */
export type ChatQueuePausedReason =
  | 'run_not_completed'
  | 'credentials'
  | 'shutting_down';

/**
 * The data of the `data-queue` part of the response stream (transient): the
 * queue when the run ended. It comes before `data-run`.
 *
 * - `nextRunId`: the queue started this run, and this backend runs it. Join it
 *   with `GET /sessions/:id/stream` after the stream ends.
 * - `paused` without `nextRunId`: nothing is sent; show the queue as paused.
 *   `pausedReason` says why, when it is known.
 *
 * @public
 */
export interface ChatQueueData extends ChatQueue {
  pausedReason?: ChatQueuePausedReason;
  nextRunId?: string;
}

/**
 * The data parts of the response stream, by the name after `data-`. The plan
 * part has the fixed id `plan`: a later one replaces an earlier one in the same
 * message.
 *
 * @public
 */
export interface ChatDataParts {
  run: ChatRunData;
  item: ChatItemData;
  notice: ChatNoticeData;
  plan: ChatPlan;
  inserted: ChatInsertedData;
  queue: ChatQueueData;
}

/**
 * The `errorText` of the `tool-output-error` part for a call whose result is
 * not known: the tool may have run, but its result was lost. The stream sends
 * it for a result with status `unknown`, and the screen shows "result unknown"
 * for it, live and after a reload.
 *
 * @public
 */
export const TOOL_RESULT_NOT_KNOWN = 'The result of the call is not known.';

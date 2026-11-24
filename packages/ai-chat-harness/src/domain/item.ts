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

import type { Plan } from './plan';

/** @public */
export type JsonPrimitive = string | number | boolean | null;

/** @public */
export type JsonObject = { [key: string]: JsonValue };

/** @public */
export type JsonArray = JsonValue[];

/** @public */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * The status of a tool result.
 *
 * - `ok`, `error`, `timeout`: the tool ran.
 * - `denied`: the user refused the call, or the policy forbids it.
 * - `invalid`: the input did not match the schema of the tool; the call never
 *   reached the tool.
 * - `unknown`: the tool may have run, but the result was lost (see
 *   `tool_started`); it is not run again.
 *
 * @public
 */
export type ToolResultStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'denied'
  | 'invalid'
  | 'unknown';

/**
 * The page the user was on when they sent a message (B-01): the path, and the
 * entity when the page is the page of one.
 *
 * @public
 */
export type PageContext = { path: string; entityRef?: string };

/**
 * How a message of the user reached the log (IN-17).
 *
 * - `direct`: the user sent it to start a run.
 * - `inserted`: the user sent it while a run was running; the run reads it at
 *   its next model call.
 * - `queued`: it waited in the queue and the host started a run with it.
 *
 * A message with no `delivery` (a record of P1) is `direct`.
 *
 * @public
 */
export type Delivery = 'direct' | 'inserted' | 'queued';

/**
 * The message of the user. `page` is where the user was; `buildModelInput`
 * tells the model with one line before the text.
 *
 * @public
 */
export type UserMessageBody = {
  kind: 'user_message';
  text: string;
  page?: PageContext;
  delivery?: Delivery;
};

/**
 * The text of the model in one step. It is written in the same append as the
 * `tool_call` items of that step, text first, so an `agent_message` that is
 * the last conversation item has no call after it.
 *
 * `readUpToSeq` is the largest `seq` the log had when the loop read it for the
 * model call that wrote this item. It does not count the summary the same
 * call may write before the model runs: a message inserted while that summary
 * was made has a smaller `seq` than the summary and was not read. An item with
 * no `readUpToSeq` (a record of P1) counts as having read up to its own `seq`.
 *
 * @public
 */
export type AgentMessageBody = {
  kind: 'agent_message';
  text: string;
  readUpToSeq?: number;
};

/**
 * A request of the model to run a tool. `step` is the number of the step of
 * the run that produced it, `position` the order inside that step. The items
 * of one step are written in one append, after the `agent_message` of that
 * step if there is one.
 *
 * `callId` is unique in the session. The loop generates it with its
 * `IdGenerator` port (the host only supplies the implementation); it is not
 * the id the model gave, which `callModel` maps to it. The log
 * refuses a second call with the same id (see {@link dedupeKeyOf}), so an
 * approval or a result always belongs to exactly one call.
 *
 * @public
 */
export type ToolCallBody = {
  kind: 'tool_call';
  callId: string;
  toolId: string;
  input: JsonObject;
  schemaHash: string;
  policy: 'allow' | 'ask';
  readOnly: boolean;
  step: number;
  position: number;
  /** See {@link AgentMessageBody}. */
  readUpToSeq?: number;
};

/** The decision of the user about one call that needs approval. @public */
export type ApprovalBody = {
  kind: 'approval';
  callId: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
};

/**
 * Written before a tool that is not read-only runs. A call with this item and
 * no result is never run again (D-25).
 *
 * @public
 */
export type ToolStartedBody = { kind: 'tool_started'; callId: string };

/** @public */
export type ToolResultBody = {
  kind: 'tool_result';
  callId: string;
  status: ToolResultStatus;
  output?: JsonValue;
  truncated?: boolean;
  message?: string;
};

/** @public */
export type PlanUpdateBody = { kind: 'plan_update'; plan: Plan };

/**
 * A summary of the items up to and including `coversUpToSeq`. It changes what
 * is sent to the model, never the log.
 *
 * @public
 */
export type SummaryBody = {
  kind: 'summary';
  coversUpToSeq: number;
  text: string;
};

/** A remark for the reader of the session. It is not sent to the model. @public */
export type NoteBody = { kind: 'note'; text: string };

/**
 * What an item says. The log of a session is a sequence of items; an item is
 * never changed after it is written (D-17).
 *
 * @public
 */
export type ItemBody =
  | UserMessageBody
  | AgentMessageBody
  | ToolCallBody
  | ApprovalBody
  | ToolStartedBody
  | ToolResultBody
  | PlanUpdateBody
  | SummaryBody
  | NoteBody;

/** @public */
export type ItemKind = ItemBody['kind'];

/** @public */
export type Item = ItemBody & {
  sessionId: string;
  /** Starts at 1 in every session and grows by one for each item. */
  seq: number;
  runId?: string;
  /** ISO 8601. */
  createdAt: string;
};

/** @public */
export type ToolCallItem = Item & ToolCallBody;

/** @public */
export type ApprovalItem = Item & ApprovalBody;

/** @public */
export type ToolStartedItem = Item & ToolStartedBody;

/** @public */
export type ToolResultItem = Item & ToolResultBody;

/**
 * The key that makes a write happen once: the kind plus the call id, for the
 * items that may be written only once per call (T-07, D-25). The log rejects a
 * second item with the same key, so a call id is never reused. Other items
 * have no key.
 *
 * @public
 */
export function dedupeKeyOf(body: ItemBody): string | undefined {
  switch (body.kind) {
    case 'tool_call':
    case 'approval':
    case 'tool_started':
    case 'tool_result':
      return `${body.kind}:${body.callId}`;
    default:
      return undefined;
  }
}

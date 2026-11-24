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

import type { Item, StopReason, ToolCallItem } from '../domain';

/**
 * How a call of the loop ended.
 *
 * - `completed`: the model answered. With `endReason`, a limit stopped the run
 *   instead (the items so far stay).
 * - `waiting_approval`: the calls in `pending` wait for the decision of the
 *   user (the ones with no decision yet, not the ones decided). The host
 *   writes the `approval` items and calls the loop again.
 * - `cancelled`: the user asked to stop, or the signal aborted.
 * - `failed`: the model call failed or gave nothing. `message` is fixed text
 *   for the user. `cause` is the original error: the host logs it and never
 *   shows it.
 *
 * @public
 */
export type RunOutcome =
  | { status: 'completed'; endReason?: StopReason }
  | { status: 'waiting_approval'; pending: ToolCallItem[] }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; cause?: unknown };

/**
 * What the loop reports while it runs, in three layers (A-03): the run, the
 * items, and the pieces of text.
 *
 * - Every item written to the log is reported once, as `item.completed`, after
 *   the write and in the order of `seq`. This includes `tool_started` and the
 *   results the loop writes itself (`denied`, `invalid`, `unknown`).
 * - `item.started` and `item.delta` are only for the screen. They are not
 *   stored, and a run that ends in between leaves no item for them. `draftId`
 *   ties them to the `item.completed` that follows. For a `tool_call` it is
 *   the `callId` the call has in the log, and `modelCallId` is the id the
 *   model gave.
 * - A step is one model call: `step.started` before it, `step.ended` after
 *   its items are written. The results of the tools come after it.
 * - A summary of the old steps (H-09) is made before the step that needs it:
 *   `summary.started`, then the `summary` item as `item.completed`, or
 *   `summary.failed` when the model call failed or gave no text. A failed
 *   summary does not fail the run. `cause` is the original error: the host
 *   logs it and never shows it. A summary is not a step.
 *
 * @public
 */
export type HarnessEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'step.started'; step: number }
  | {
      type: 'item.started';
      draftId: string;
      kind: 'agent_message' | 'tool_call';
      /** For a `tool_call`: the id the model gave to the call. */
      modelCallId?: string;
    }
  | { type: 'item.delta'; draftId: string; text: string }
  | { type: 'item.completed'; draftId?: string; item: Item }
  | { type: 'step.ended'; step: number }
  | { type: 'summary.started'; coversUpToSeq: number }
  | { type: 'summary.failed'; cause?: unknown }
  | { type: 'run.ended'; outcome: RunOutcome };

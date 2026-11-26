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

import type { ModelInputSize, ToolResultStatus } from '../../domain';

/**
 * How a model call ended.
 *
 * - `ok`: the model answered.
 * - `empty`: the answer had no text and no call.
 * - `failed`: the call threw.
 * - `cancelled`: the signal of the run aborted for another reason than its
 *   deadline: the user stopped the run, the backend shut down, or the host
 *   lost the lease of the run.
 * - `timeout`: the working time of the run ran out.
 *
 * @public
 */
export type ModelCallOutcome =
  | 'ok'
  | 'empty'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/**
 * What became of the text of one context provider in a step: in the context
 * (`ok`), in the context but cut (`cut`), nothing to say (`empty`), not
 * available because it failed (`failed`) or did not answer in time
 * (`timeout`), or left out because the room for all providers was used up
 * (`left_out`).
 *
 * @public
 */
export type ContextProviderStatus =
  | 'ok'
  | 'cut'
  | 'empty'
  | 'failed'
  | 'timeout'
  | 'left_out';

/**
 * One context provider in one step. `chars` is the length of its text in the
 * context, after it was normalized and cut; 0 when the text is not there.
 *
 * @public
 */
export type ContextProviderRecord = {
  id: string;
  status: ContextProviderStatus;
  chars: number;
};

/**
 * One model call of a run, as the loop measures it (O-01). It has numbers,
 * ids and fixed words only: no text of the conversation, of the prompt, of a
 * tool, or of an error.
 *
 * @public
 */
export type ModelCallRecord = {
  sessionId: string;
  runId: string;
  agentId: string;
  /** The id of the model, when the host gave one (`AdvanceRunRequest.modelId`). */
  modelId?: string;
  /** `step`: a step of the run. `summary`: the summary made before step `step`. */
  purpose: 'step' | 'summary';
  step: number;
  /**
   * From the call of the model to the end of its stream, by the `Clock`. A
   * wait of the host before the call (a rate limit) is part of it.
   */
  durationMs: number;
  outcome: ModelCallOutcome;
  /**
   * The `status` of the error of a failed call, when it is an integer from 100
   * to 599 (an HTTP status). The error itself is never passed on.
   */
  errorStatus?: number;
  /** What the model server reported (`usage` chunk), when it did. */
  inputTokens?: number;
  outputTokens?: number;
  /** The tool calls the model asked for in this call. */
  toolCallsRequested: number;
  /** The size of what was sent, estimated by the loop. */
  context: ModelInputSize;
  /** The context providers of the step, in their order. Not for a summary. */
  providers?: ContextProviderRecord[];
};

/**
 * Why a call got a `denied` result: the policy, the calls the run may make,
 * the calls of one step, a `beforeToolCall` hook, the user, or a change
 * before it in the step that went over its time.
 *
 * @public
 */
export type ToolDeniedReason =
  | 'policy'
  | 'run_limit'
  | 'step_limit'
  | 'hook'
  | 'user'
  | 'earlier_write_timed_out';

/**
 * One tool result written to the log (O-01). Numbers, ids and fixed words
 * only: no input, output or message of the tool.
 *
 * @public
 */
export type ToolCallRecord = {
  sessionId: string;
  runId: string;
  agentId: string;
  step: number;
  position: number;
  callId: string;
  /**
   * The id of the tool, or `unknown` when the model named a tool that is not
   * offered (its name is text of the model).
   */
  toolId: string;
  readOnly: boolean;
  /** The status as written, after the `afterToolCall` hooks. */
  status: ToolResultStatus;
  /** Set when `status` is `denied`. */
  reason?: ToolDeniedReason;
  /**
   * How long the tool ran, by the `Clock`, without the hooks and without the
   * wait for an approval. Only for a call that ran through the tool gateway.
   */
  durationMs?: number;
  truncated?: boolean;
};

/**
 * Receives what the loop measures (O-01). The host turns it into logs and
 * metrics. The loop calls it when the item of the record is written, does not
 * wait for it and ignores what it throws, so it can never change a run.
 *
 * @public
 */
export interface RunObserver {
  /** One model call: each step and each summary, when the call ended. */
  modelCall(record: ModelCallRecord): void;
  /** One `tool_result` item, after it was written to the log. */
  toolCall(record: ToolCallRecord): void;
}

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

import type {
  JsonObject,
  JsonValue,
  ToolCallItem,
  ToolDescriptor,
} from '../../domain';

/**
 * What the loop passes along with every call. The core does not read
 * `principal`; it only hands it to the gateway and the extensions.
 *
 * @public
 */
export interface CallContext {
  sessionId: string;
  runId: string;
  principal: unknown;
  /**
   * Where the user is (B-01), as the message that started or carries on the
   * run says. The log keeps it with the message (`user_message`); a call that
   * a decision or a resume carries on has the page of that request.
   */
  page?: { path: string; entityRef?: string };
}

/** @public */
export type ValidationResult =
  | { valid: true }
  | { valid: false; message: string };

/**
 * What a tool gave back. `timeout` and `error` are results of the tool; the
 * loop writes them as they are.
 *
 * @public
 */
export type ToolOutput = {
  status: 'ok' | 'error' | 'timeout';
  output?: JsonValue;
  truncated?: boolean;
  message?: string;
};

/**
 * The tools the loop can use. The host decides which tools a session has and
 * how they run; the loop decides whether they run (the policy).
 *
 * @public
 */
export interface ToolGateway {
  /** The tools this session may use now. */
  list(ctx: CallContext): Promise<ToolDescriptor[]>;
  /** Checks the input of a call against the schema of the tool (T-05). */
  validate(
    toolId: string,
    input: JsonObject,
    ctx: CallContext,
  ): Promise<ValidationResult>;
  /**
   * Runs the call. A failure of the tool is a result with status `error`;
   * throwing is for a broken gateway, and the loop writes an `error` result
   * for it too.
   */
  execute(
    call: ToolCallItem,
    ctx: CallContext,
    opts: { signal: AbortSignal },
  ): Promise<ToolOutput>;
}

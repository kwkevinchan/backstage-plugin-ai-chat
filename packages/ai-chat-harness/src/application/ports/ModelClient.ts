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

import type { JsonValue, ModelInput } from '../../domain';

/**
 * One piece of the answer of the model.
 *
 * - `text`: a piece of the text, in order.
 * - `tool_call`: the model asks for a tool. `modelCallId` is the id the model
 *   gave to the call; it is only used to tell the calls of one answer apart
 *   (the loop gives the call its own `callId`). `input` is the arguments,
 *   already parsed; anything that is not a JSON object is answered with an
 *   `invalid` result.
 *
 * @public
 */
export type ModelChunk =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      modelCallId: string;
      toolId: string;
      input: JsonValue;
    };

/**
 * Calls the model. The adapter maps tool ids to the names the API accepts,
 * turns `input` into the argument string, and maps the ids of the calls in
 * the answer back (a `tool_call` chunk carries the id the model gave).
 *
 * @public
 */
export interface ModelClient {
  /**
   * The answer of the model as a stream. Throws when the call fails; the loop
   * ends the run as `failed`. Stops, and may throw, when the signal aborts.
   */
  stream(
    input: ModelInput,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ModelChunk>;
  readonly capabilities: { parallelToolCalls: boolean };
}

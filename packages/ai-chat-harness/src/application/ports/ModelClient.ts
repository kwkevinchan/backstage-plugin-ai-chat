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

import type { JsonValue, ModelImage, ModelInput } from '../../domain';

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
 * The bytes of an image of a message, as `ModelStreamOptions.readImage`
 * gives them.
 *
 * @public
 */
export type ModelImageData = {
  /** For example `image/png`. */
  mediaType: string;
  bytes: Uint8Array;
};

/**
 * What a model call gets besides its input.
 *
 * @public
 */
export type ModelStreamOptions = {
  /** Aborts when the run stops or reaches its deadline. */
  signal: AbortSignal;
  /** The session of the call. */
  sessionId: string;
  /**
   * Reads an image of the input of this call, from the attachments of the
   * session. `undefined` when the image is not there any more (it was
   * deleted). The host gives it; the backend plugin gives it to every model
   * client. The core never calls it.
   */
  readImage?: (image: ModelImage) => Promise<ModelImageData | undefined>;
};

/**
 * Calls the model. The adapter maps tool ids to the names the API accepts,
 * turns `input` into the argument string, and maps the ids of the calls in
 * the answer back (a `tool_call` chunk carries the id the model gave). The
 * images of a message carry no bytes (`ModelImage`): the adapter reads them
 * with `opts.readImage`, or from the attachments of `opts.sessionId`, so the
 * core does no I/O (X-09).
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
    opts: ModelStreamOptions,
  ): AsyncIterable<ModelChunk>;
  /**
   * What the model can do (X-09). `images`: it reads the images of a message
   * (IN-05); when it is `false`, the loop never gives it an image.
   * `parallelToolCalls`: it may ask for more than one tool in one answer. The
   * loop runs the read-only calls of a step at the same time either way
   * (D-09); an adapter may ask the server for parallel calls with it.
   */
  readonly capabilities: { parallelToolCalls: boolean; images: boolean };
}

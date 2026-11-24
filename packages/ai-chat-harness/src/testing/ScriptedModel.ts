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
  JsonValue,
  ModelChunk,
  ModelClient,
  ModelInput,
} from '@kwkevinchan/ai-chat-harness';

/**
 * What the model does in one call: the chunks of its answer, an error to
 * throw, `waitForAbort` (a call that gives nothing and ends, with an error,
 * when the signal aborts), or a function that works it out from the input (and may do something
 * on the way, such as moving a fake clock).
 *
 * @public
 */
export type ScriptedStep =
  | ModelChunk[]
  | Error
  | typeof waitForAbort
  | ((input: ModelInput, callNumber: number) => ModelChunk[] | Error);

/**
 * A step in which the model call does not end until the signal aborts.
 *
 * @public
 */
export const waitForAbort = Symbol('waitForAbort');

/** A text chunk. @public */
export const say = (text: string): ModelChunk => ({ type: 'text', text });

/** A tool call chunk. `modelCallId` is the id the model gives. @public */
export const callTool = (
  modelCallId: string,
  toolId: string,
  input: JsonValue = {},
): ModelChunk => ({ type: 'tool_call', modelCallId, toolId, input });

/**
 * A model that answers from a script: the first call gets the first step, the
 * second call the second, and so on. It keeps the input of every call. A call
 * after the last step throws.
 *
 * @public
 */
export class ScriptedModel implements ModelClient {
  readonly capabilities: ModelClient['capabilities'];
  /** The input of every call, in order. */
  readonly inputs: ModelInput[] = [];
  /** The session of every call, in order. */
  readonly sessionIds: string[] = [];

  constructor(
    private readonly script: ScriptedStep[],
    capabilities: Partial<ModelClient['capabilities']> = {},
  ) {
    this.capabilities = {
      parallelToolCalls: false,
      images: false,
      ...capabilities,
    };
  }

  async *stream(
    input: ModelInput,
    opts: { signal: AbortSignal; sessionId: string },
  ): AsyncIterable<ModelChunk> {
    const number = this.inputs.length;
    this.inputs.push(structuredClone(input));
    this.sessionIds.push(opts.sessionId);
    const entry = this.script[number];
    if (entry === undefined) {
      throw new Error(`ScriptedModel has no step for call ${number + 1}`);
    }
    const step = typeof entry === 'function' ? entry(input, number) : entry;
    if (step instanceof Error) throw step;
    if (step === waitForAbort) {
      await new Promise<void>(resolve => {
        if (opts.signal.aborted) resolve();
        opts.signal.addEventListener('abort', () => resolve());
      });
      throw new Error('aborted');
    }
    for (const chunk of step) {
      if (opts.signal.aborted) throw new Error('aborted');
      yield chunk;
    }
  }
}

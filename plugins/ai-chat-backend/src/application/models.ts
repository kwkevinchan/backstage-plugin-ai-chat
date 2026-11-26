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
  AgentDefinition,
  Clock,
  ModelChunk,
  ModelClient,
  ModelImage,
  ModelImageData,
  ModelInput,
  ModelStreamOptions,
} from '@kwkevinchan/ai-chat-harness';
import { AttachmentNotFound } from '../domain';
import type { AttachmentStore, ModelCallLimiter } from './ports';
import { abortableSleep } from './sleep';

/** The id of the model of `aiChat.llm`, which an agent without `model` uses. */
export const DEFAULT_MODEL_ID = 'default';

/** The most the wait for a minute is moved later, so backends do not all retry at once. */
const RETRY_JITTER_MS = 250;

/**
 * The client of one model as the host gives it to the loop and to the titles
 * (X-09, P-06):
 *
 * - `readImage` reads an image of the input from the attachments of the
 *   session of the call; an image that is gone is `undefined`. A client of a
 *   module gets the bytes this way.
 * - With `perMinute`, every call first takes a turn from the limiter, shared
 *   by all backends. Without a turn it waits for the next minute and asks
 *   again; when the signal aborts while it waits, the call throws (the check
 *   at the top of the loop) and the model is not called.
 */
export class HostModelClient implements ModelClient {
  readonly capabilities: ModelClient['capabilities'];

  constructor(
    private readonly inner: ModelClient,
    private readonly deps: {
      modelId: string;
      attachments: Pick<AttachmentStore, 'get'>;
      clock: Clock;
      rate?: { limiter: ModelCallLimiter; perMinute: number };
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    },
  ) {
    this.capabilities = inner.capabilities;
  }

  async *stream(
    input: ModelInput,
    opts: ModelStreamOptions,
  ): AsyncIterable<ModelChunk> {
    await this.takeTurn(opts.signal);
    const { attachments } = this.deps;
    const readImage = async (
      image: ModelImage,
    ): Promise<ModelImageData | undefined> => {
      try {
        const { bytes, meta } = await attachments.get(
          opts.sessionId,
          image.attachmentId,
        );
        return { mediaType: meta.mediaType, bytes };
      } catch (error) {
        if (error instanceof AttachmentNotFound) return undefined;
        throw error;
      }
    };
    yield* this.inner.stream(input, { ...opts, readImage });
  }

  private async takeTurn(signal: AbortSignal): Promise<void> {
    const { rate, clock, modelId } = this.deps;
    if (!rate) return;
    const sleep = this.deps.sleep ?? abortableSleep;
    for (;;) {
      signal.throwIfAborted();
      const turn = await rate.limiter.tryAcquire(
        modelId,
        rate.perMinute,
        clock.now(),
      );
      if (turn.acquired) return;
      const wait =
        Math.max(0, turn.retryAt.getTime() - clock.now().getTime()) +
        Math.floor(Math.random() * RETRY_JITTER_MS);
      await sleep(wait, signal);
    }
  }
}

/** The model clients of the installation by id, `default` among them. */
export class ModelCatalog {
  constructor(private readonly clients: ReadonlyMap<string, ModelClient>) {
    if (!clients.has(DEFAULT_MODEL_ID)) {
      throw new Error(`There is no model ${DEFAULT_MODEL_ID}`);
    }
  }

  /** The client of the model of the agent; `default` when it names none. */
  forAgent(agent: Pick<AgentDefinition, 'model'>): ModelClient {
    const id = agent.model ?? DEFAULT_MODEL_ID;
    const client = this.clients.get(id);
    // The catalog of agents refuses an unknown model at startup.
    if (!client) throw new Error(`There is no model ${id}`);
    return client;
  }
}

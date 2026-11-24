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
  ModelMessage,
  ToolDescriptor,
} from '@kwkevinchan/ai-chat-harness';
import type { JSONSchema7 } from 'json-schema';
import type { AttachmentStore, Logger } from '../../application/ports';
import { AttachmentNotFound } from '../../domain';
import type {
  LlmClient,
  LlmContentPart,
  LlmMessage,
  LlmTool,
} from './OpenAiCompatibleClient';

/** The longest function name that OpenAI-compatible servers accept. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * The `ModelClient` of the core on an OpenAI-compatible Chat Completions
 * server (the `LlmClient` that makes the HTTP call).
 *
 * - The function names of the API must match `^[a-zA-Z0-9_-]+$`, but tool ids
 *   have a colon (`catalog:get-entity`). Each call gets its own names, the id
 *   with every other character replaced by `_` (made unique with a number), and
 *   the name in the answer is mapped back. A name that matches no tool is given
 *   to the loop as it is, and the loop answers it as an unknown tool.
 * - The arguments are text that may not be valid JSON. A text that does not
 *   parse is passed as a string, which the loop answers with an `invalid`
 *   result; an empty text is `{}`.
 * - The images of a user message are read from the `AttachmentStore`, of the
 *   session of the call, and sent as `image_url` parts with a data URL
 *   (`data:<type>;base64,<bytes>`) after the text. A message without images
 *   keeps a string as its content. An image that cannot be read (it was
 *   deleted) becomes a line `[image: <name>, not available]` in the text, and
 *   the call goes on. The bytes are read at every call and not kept.
 * - The text arrives as it is generated; the tool calls arrive when the
 *   answer is complete, because the server sends the arguments in pieces.
 */
export class OpenAiCompatibleModelClient implements ModelClient {
  readonly capabilities: ModelClient['capabilities'];

  /**
   * @param deps.images - `aiChat.llm.images`: the model reads images. The
   *   loop never gives an image to a model that does not.
   */
  constructor(
    private readonly llm: LlmClient,
    private readonly deps: {
      attachments: AttachmentStore;
      images: boolean;
      logger: Logger;
    },
  ) {
    this.capabilities = { parallelToolCalls: false, images: deps.images };
  }

  async *stream(
    input: ModelInput,
    opts: { signal: AbortSignal; sessionId: string },
  ): AsyncIterable<ModelChunk> {
    const names = toolNames(input);
    const messages = await this.toLlmMessages(input, names, opts.sessionId);
    const toolIdOf = new Map([...names].map(([id, name]) => [name, id]));
    const pending: string[] = [];
    const waiters: (() => void)[] = [];
    const notify = () => {
      for (const wake of waiters.splice(0)) wake();
    };

    const result = this.llm
      .complete({
        messages,
        tools: input.tools.map(tool => toLlmTool(tool, names)),
        signal: opts.signal,
        onText: text => {
          pending.push(text);
          notify();
        },
      })
      .then(
        value => ({ value }),
        error => ({ error }),
      );
    let finished = false;
    void result.then(() => {
      finished = true;
      notify();
    });

    while (!finished || pending.length > 0) {
      const text = pending.shift();
      if (text !== undefined) {
        yield { type: 'text', text };
      } else if (!finished) {
        await new Promise<void>(resolve => waiters.push(resolve));
      }
    }

    const outcome = await result;
    if ('error' in outcome) throw outcome.error;
    for (const call of outcome.value.toolCalls) {
      yield {
        type: 'tool_call',
        modelCallId: call.id,
        toolId: toolIdOf.get(call.name) ?? call.name,
        input: parseArguments(call.arguments),
      };
    }
  }

  private async toLlmMessages(
    input: ModelInput,
    names: Map<string, string>,
    sessionId: string,
  ): Promise<LlmMessage[]> {
    const messages: LlmMessage[] = [{ role: 'system', content: input.system }];
    for (const message of input.messages) {
      messages.push(
        message.role === 'user'
          ? await this.toUserMessage(message, sessionId)
          : toLlmMessage(message, names),
      );
    }
    return messages;
  }

  private async toUserMessage(
    message: Extract<ModelMessage, { role: 'user' }>,
    sessionId: string,
  ): Promise<LlmMessage> {
    if (!message.images || message.images.length === 0) {
      return { role: 'user', content: message.content };
    }
    const parts: LlmContentPart[] = [];
    const missing: string[] = [];
    for (const image of message.images) {
      try {
        const { bytes, meta } = await this.deps.attachments.get(
          sessionId,
          image.attachmentId,
        );
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${meta.mediaType};base64,${Buffer.from(bytes).toString(
              'base64',
            )}`,
          },
        });
      } catch (error) {
        if (!(error instanceof AttachmentNotFound)) throw error;
        this.deps.logger.warn('An image of a message is not available', {
          sessionId,
          attachmentId: image.attachmentId,
        });
        missing.push(`[image: ${image.name}, not available]`);
      }
    }
    if (parts.length === 0) {
      return {
        role: 'user',
        content: [message.content, ...missing].join('\n'),
      };
    }
    return {
      role: 'user',
      content: [
        { type: 'text', text: [message.content, ...missing].join('\n') },
        ...parts,
      ],
    };
  }
}

/**
 * A name for every tool of the input, and for every tool the history calls:
 * a tool that is no longer offered (its toolset is off now) still appears in
 * the messages.
 */
function toolNames(input: ModelInput): Map<string, string> {
  const ids = new Set(input.tools.map(tool => tool.id));
  for (const message of input.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) ids.add(call.toolId);
    }
  }
  const byName = new Set<string>();
  const byId = new Map<string, string>();
  for (const id of [...ids].sort()) {
    const base = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    let name = base.slice(0, MAX_TOOL_NAME_LENGTH);
    for (let n = 2; byName.has(name); n++) {
      const suffix = `_${n}`;
      name = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    }
    byName.add(name);
    byId.set(id, name);
  }
  return byId;
}

function toLlmTool(tool: ToolDescriptor, names: Map<string, string>): LlmTool {
  // Some servers refuse the `$schema` keyword.
  const { $schema: _ignored, ...parameters } = tool.inputSchema as JSONSchema7;
  return {
    type: 'function',
    function: {
      name: names.get(tool.id) ?? tool.id,
      description: tool.description,
      parameters,
    },
  };
}

function toLlmMessage(
  message: ModelMessage,
  names: Map<string, string>,
): LlmMessage {
  switch (message.role) {
    case 'user':
      // A message with images is made by `toUserMessage`.
      return { role: 'user', content: message.content };
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.callId,
        content: message.content,
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content === '' ? null : message.content,
        ...(message.toolCalls.length > 0 && {
          tool_calls: message.toolCalls.map(call => ({
            id: call.callId,
            type: 'function' as const,
            function: {
              name: names.get(call.toolId) ?? call.toolId,
              arguments: JSON.stringify(call.input),
            },
          })),
        }),
      };
    default:
      return message satisfies never;
  }
}

function parseArguments(text: string): JsonValue {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

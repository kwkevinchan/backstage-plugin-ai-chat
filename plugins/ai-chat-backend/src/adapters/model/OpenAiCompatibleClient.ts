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

import { randomUUID } from 'node:crypto';
import type { JSONSchema7 } from 'json-schema';
import type { AiChatConfig } from '../../config';

/** A message in the form of the Chat Completions API. */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LlmContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema7;
  };
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** The JSON text that the model wrote; it may not be valid JSON. */
  arguments: string;
}

export interface LlmResult {
  content: string;
  toolCalls: LlmToolCall[];
  /** The tokens of the call, when the server reported them. */
  usage?: LlmUsage;
}

/** The tokens of one call, as the server reports them in `usage`. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmTool[];
  /**
   * Sends `parallel_tool_calls: true` with the tools. Not sent otherwise, for
   * servers that do not know the field.
   */
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  /** Called with each piece of text as it arrives. */
  onText?: (text: string) => void;
}

/** The model side of the chat; the tests replace it. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResult>;
}

/** An answer that the model server refused or that could not be read. */
export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

const MAX_ERROR_BODY = 300;
const MAX_CALL_ID_LENGTH = 255;

/**
 * The ID of a tool call goes into a column of 255 characters. A missing or
 * longer ID is replaced; the replacement is stored and sent back to the model
 * in the assistant message and in the tool message, so the two match.
 */
function safeCallId(id: unknown): string {
  return typeof id === 'string' && id && id.length <= MAX_CALL_ID_LENGTH
    ? id
    : `call_${randomUUID()}`;
}

/**
 * Calls `POST {baseUrl}/chat/completions` of an OpenAI-compatible server and
 * reads the streamed answer. The key goes only into the `Authorization`
 * header; it is never logged or put in an error message.
 */
export class OpenAiCompatibleClient implements LlmClient {
  constructor(
    private readonly config: Pick<
      AiChatConfig['llm'],
      'baseUrl' | 'apiKey' | 'model' | 'timeoutMs'
    > &
      Partial<Pick<AiChatConfig['llm'], 'reportUsage'>>,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          ...(request.tools.length > 0 ? { tools: request.tools } : {}),
          ...(request.tools.length > 0 && request.parallelToolCalls
            ? { parallel_tool_calls: true }
            : {}),
          stream: true,
          // The tokens come in a last chunk; a server that does not know the
          // field may refuse it, so the configuration can turn it off.
          ...(this.config.reportUsage !== false && {
            stream_options: { include_usage: true },
          }),
        }),
      });
    } catch (error) {
      throw new LlmError(describeFetchError(error, timeout, request.signal));
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(
        0,
        MAX_ERROR_BODY,
      );
      throw new LlmError(
        `The model server answered ${response.status}${
          body ? `: ${body}` : ''
        }`,
        response.status,
      );
    }
    try {
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('application/json')) {
        return readWholeAnswer(await response.json(), request);
      }
      return await readStream(response, request);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(describeFetchError(error, timeout, request.signal));
    }
  }
}

function describeFetchError(
  error: unknown,
  timeout: AbortSignal,
  caller?: AbortSignal,
): string {
  if (caller?.aborted) return 'The request to the model server was cancelled';
  if (timeout.aborted) return 'The model server did not answer in time';
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  return `Could not reach the model server${cause ? ` (${cause})` : ''}`;
}

function readWholeAnswer(body: any, request: LlmRequest): LlmResult {
  const message = body?.choices?.[0]?.message;
  if (!message) throw new LlmError('The model server sent no answer');
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) request.onText?.(content);
  const toolCalls: LlmToolCall[] = (message.tool_calls ?? []).map(
    (call: any) => ({
      id: safeCallId(call.id),
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    }),
  );
  const usage = usageOf(body?.usage);
  return { content, toolCalls, ...(usage && { usage }) };
}

/** The tokens of `usage` in an answer, when both counts are there. */
function usageOf(usage: any): LlmUsage | undefined {
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (!count(usage?.prompt_tokens) || !count(usage?.completion_tokens)) {
    return undefined;
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  };
}

async function readStream(
  response: Response,
  request: LlmRequest,
): Promise<LlmResult> {
  if (!response.body) throw new LlmError('The model server sent no answer');
  let content = '';
  let usage: LlmUsage | undefined;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  const handle = (data: string) => {
    if (data === '[DONE]') return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk?.error) {
      throw new LlmError(
        `The model server reported an error: ${String(
          chunk.error.message ?? chunk.error,
        ).slice(0, MAX_ERROR_BODY)}`,
      );
    }
    // The chunk of the usage has no choices.
    usage = usageOf(chunk?.usage) ?? usage;
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      request.onText?.(delta.content);
    }
    for (const piece of delta.tool_calls ?? []) {
      // Without an index, a piece with an ID starts a call and a piece
      // without one goes on with the last call.
      let index = calls.length;
      if (typeof piece.index === 'number') index = piece.index;
      else if (!piece.id) index = Math.max(calls.length - 1, 0);
      const call = (calls[index] ??= { id: '', name: '', arguments: '' });
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name += piece.function.name;
      if (piece.function?.arguments) call.arguments += piece.function.arguments;
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    // An event ends with a blank line.
    for (let end = findEventEnd(buffer); end >= 0; end = findEventEnd(buffer)) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      emitEvent(event, handle);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) emitEvent(buffer, handle);

  return {
    content,
    toolCalls: calls
      .filter(Boolean)
      .map(call => ({ ...call, id: safeCallId(call.id) })),
    ...(usage && { usage }),
  };
}

function findEventEnd(buffer: string): number {
  return buffer.search(/\r?\n\r?\n/);
}

function emitEvent(event: string, handle: (data: string) => void) {
  const data = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (data) handle(data);
}

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

import {
  parseJsonEventStream,
  uiMessageChunkSchema,
  type ChatTransport,
  type UIMessageChunk,
} from 'ai';
import type { ChatPageContext } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import type { ChatUiMessage } from '../domain/types';

/**
 * What the screen asks of `sendMessages` besides a new message, in the `body`
 * of the request options.
 *
 * - `callId` and `approved`: store this decision. The transport does not look
 *   at the parts of the messages to find the decision: after a reload, the
 *   decisions that are stored already are `approval-responded` as well.
 * - `resume`: carry on a run whose decisions are all stored.
 */
export type ChatRequestBody = {
  callId?: string;
  approved?: boolean;
  resume?: boolean;
};

export interface AiChatTransportOptions {
  api: AiChatApi;
  sessionId: string;
  /** The page the user is on, sent with every request that starts or carries on a run. */
  getPage(): ChatPageContext;
  /** Called when the decision of a request is read, so the screen can clear it. */
  onDecisionTaken?(): void;
  /**
   * Called when the answer to a decision was JSON, not a stream: the run did
   * not start in this request. The stream ends without chunks; the screen
   * follows the run itself.
   */
  onDecisionStored?(): void;
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes(
    'text/event-stream',
  );
}

/** The chunks of the body of an event stream response. */
export function chunksOf(response: Response): ReadableStream<UIMessageChunk> {
  if (!response.body) return emptyStream();
  return parseJsonEventStream({
    stream: response.body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (!chunk.success) throw chunk.error;
        controller.enqueue(chunk.value);
      },
    }),
  );
}

function emptyStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream({ start: controller => controller.close() });
}

function lastUserText(messages: ChatUiMessage[]): string {
  const message = [...messages].reverse().find(m => m.role === 'user');
  return (message?.parts ?? [])
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('');
}

/**
 * The transport of `useChat` for the chat backend (architecture, "frontend").
 * It sends the last message of the user, not the history, which the backend
 * has; a decision, or a request to carry on, goes to its own route. After a
 * reload it follows the run from its first item, so `resumeStreamIsReplay`.
 */
export class AiChatTransport implements ChatTransport<ChatUiMessage> {
  readonly resumeStreamIsReplay = true;

  constructor(private readonly options: AiChatTransportOptions) {}

  async sendMessages(request: {
    messages: ChatUiMessage[];
    abortSignal: AbortSignal | undefined;
    body?: object;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const { api, sessionId, getPage } = this.options;
    const body = (request.body ?? {}) as ChatRequestBody;
    const page = getPage();
    if (body.callId !== undefined && body.approved !== undefined) {
      this.options.onDecisionTaken?.();
      const response = await api.decide(
        sessionId,
        body.callId,
        { approved: body.approved, page },
        request.abortSignal,
      );
      if (isEventStream(response)) return chunksOf(response);
      await response.body?.cancel();
      this.options.onDecisionStored?.();
      return emptyStream();
    }
    if (body.resume) {
      const response = await api.resume(
        sessionId,
        { page },
        request.abortSignal,
      );
      return response ? chunksOf(response) : emptyStream();
    }
    const response = await api.sendMessage(
      sessionId,
      { text: lastUserText(request.messages), page },
      request.abortSignal,
    );
    return chunksOf(response);
  }

  async reconnectToStream(request: {
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // No `afterSeq`: the SDK needs the whole run to find the tool parts.
    const response = await this.options.api.follow(
      this.options.sessionId,
      request.abortSignal,
    );
    return response ? chunksOf(response) : null;
  }
}

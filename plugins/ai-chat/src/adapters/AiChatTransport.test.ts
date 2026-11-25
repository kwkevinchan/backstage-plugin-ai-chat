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

import { jsonResponse, mockApi, streamResponse } from '../testData';
import type { ChatUiMessage } from '../domain/types';
import { AiChatTransport, chunksOf } from './AiChatTransport';

const page = { path: '/ai-chat/s-1' };
const messages: ChatUiMessage[] = [
  { id: 'a', role: 'user', parts: [{ type: 'text', text: 'first' }] },
  { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
  { id: 'c', role: 'user', parts: [{ type: 'text', text: 'second' }] },
];

async function read(stream: ReadableStream<unknown>) {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function setup(overrides = {}) {
  const api = mockApi();
  const onDecisionTaken = jest.fn();
  const onDecisionStored = jest.fn();
  const transport = new AiChatTransport({
    api,
    sessionId: 's-1',
    getPage: () => page,
    onDecisionTaken,
    onDecisionStored,
    ...overrides,
  });
  return { api, transport, onDecisionTaken, onDecisionStored };
}

describe('AiChatTransport', () => {
  it('replays a reconnect from the first item of the run', () => {
    expect(setup().transport.resumeStreamIsReplay).toBe(true);
  });

  it('sends only the last text of the user, with the page', async () => {
    const { api, transport } = setup();
    api.sendMessage.mockResolvedValue(
      streamResponse([{ type: 'start', messageId: 'run_r-1' }]),
    );

    const chunks = await read(
      await transport.sendMessages({
        messages,
        abortSignal: undefined,
      } as never),
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'second', page },
      undefined,
    );
    expect(chunks).toEqual([{ type: 'start', messageId: 'run_r-1' }]);
  });

  it('sends the image ids of the last message of the user', async () => {
    const { api, transport } = setup();
    api.sendMessage.mockResolvedValue(
      streamResponse([{ type: 'start', messageId: 'run_r-1' }]),
    );
    const withImage: ChatUiMessage[] = [
      {
        id: 'c',
        role: 'user',
        parts: [{ type: 'text', text: '' }],
        metadata: {
          attachments: [
            { id: 'att-1', mediaType: 'image/png', name: 'dot.png', size: 8 },
          ],
        },
      },
    ];

    await transport.sendMessages({
      messages: withImage,
      abortSignal: undefined,
    } as never);

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: '', attachmentIds: ['att-1'], page },
      undefined,
    );
  });

  it('sends the decision of the body to its own route and clears it', async () => {
    const { api, transport, onDecisionTaken } = setup();
    api.decide.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        { type: 'tool-approval-response', approvalId: 'c2', approved: false },
      ]),
    );

    const chunks = await read(
      await transport.sendMessages({
        messages,
        abortSignal: undefined,
        body: { callId: 'c2', approved: false },
      } as never),
    );

    expect(api.decide).toHaveBeenCalledWith(
      's-1',
      'c2',
      { approved: false, page },
      undefined,
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(onDecisionTaken).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(2);
  });

  it('ends without chunks when the answer to a decision is JSON, and says so', async () => {
    const { api, transport, onDecisionStored } = setup();
    api.decide.mockResolvedValue(jsonResponse({ approved: true }));

    const chunks = await read(
      await transport.sendMessages({
        messages,
        abortSignal: undefined,
        body: { callId: 'c1', approved: true },
      } as never),
    );

    expect(chunks).toEqual([]);
    expect(onDecisionStored).toHaveBeenCalledTimes(1);
    expect(api.follow).not.toHaveBeenCalled();
  });

  it('carries a run on through the resume route', async () => {
    const { api, transport } = setup();
    api.resume.mockResolvedValue(
      streamResponse([{ type: 'start', messageId: 'run_r-1' }]),
    );

    await read(
      await transport.sendMessages({
        messages,
        abortSignal: undefined,
        body: { resume: true },
      } as never),
    );

    expect(api.resume).toHaveBeenCalledWith('s-1', { page }, undefined);
  });

  it('says so when the resume has nothing to carry on, and ends without chunks', async () => {
    const onNothingToResume = jest.fn();
    const { api, transport } = setup({ onNothingToResume });
    api.resume.mockResolvedValue(undefined);

    const chunks = await read(
      await transport.sendMessages({
        messages,
        abortSignal: undefined,
        body: { resume: true },
      } as never),
    );

    expect(chunks).toEqual([]);
    expect(onNothingToResume).toHaveBeenCalledTimes(1);
  });

  it('follows the run without afterSeq, and gives null when there is nothing', async () => {
    const { api, transport } = setup();
    expect(await transport.reconnectToStream({})).toBeNull();
    api.follow.mockResolvedValue(
      streamResponse([{ type: 'start', messageId: 'run_r-1' }]),
    );

    const stream = await transport.reconnectToStream({});

    expect(await read(stream!)).toEqual([
      { type: 'start', messageId: 'run_r-1' },
    ]);
    expect(api.follow).toHaveBeenLastCalledWith('s-1', undefined);
  });

  it('fails on a chunk that the protocol does not know', async () => {
    const stream = chunksOf(
      streamResponse([{ type: 'tool-approval-requested' }]),
    );
    await expect(read(stream)).rejects.toBeDefined();
  });
});

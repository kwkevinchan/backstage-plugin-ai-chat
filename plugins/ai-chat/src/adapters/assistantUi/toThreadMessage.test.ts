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

import { fromThreadMessageLike } from '@assistant-ui/react';
import { NOT_RUN, RESULT_NOT_KNOWN } from '../../domain/toolView';
import type { ChatUiMessage, ToolPart } from '../../domain/types';
import { chatAttachmentOf } from './attachmentAdapter';
import { toThreadMessage, toToolCall } from './toThreadMessage';

// The contract between the messages of `useSessionChat` (AI SDK UI messages
// with the data parts of the chat) and the messages of assistant-ui. Each
// case also goes through `fromThreadMessageLike`, the conversion of
// assistant-ui itself, so that an upgrade that reads the shape differently
// fails here.

const tool = (extra: object): ToolPart =>
  ({
    type: 'tool-dev-actions:restart-service',
    toolCallId: 'c1',
    input: { name: 'payments' },
    ...extra,
  } as unknown as ToolPart);

const assistant = (...parts: object[]): ChatUiMessage =>
  ({ id: 'run_1', role: 'assistant', parts } as unknown as ChatUiMessage);

const complete = { type: 'complete', reason: 'stop' } as const;

function thread(message: ChatUiMessage) {
  return fromThreadMessageLike(toThreadMessage(message), 'x', complete);
}

function onlyCall(message: ChatUiMessage) {
  const parts = thread(message).content.filter(p => p.type === 'tool-call');
  expect(parts).toHaveLength(1);
  return parts[0] as Extract<
    ReturnType<typeof thread>['content'][number],
    { type: 'tool-call' }
  >;
}

describe('toThreadMessage', () => {
  it('keeps the id, the role and the text of user and assistant messages', () => {
    const user: ChatUiMessage = {
      id: 'item_1',
      role: 'user',
      parts: [{ type: 'text', text: 'restart payments' }],
    };
    expect(thread(user)).toMatchObject({
      id: 'item_1',
      role: 'user',
      content: [{ type: 'text', text: 'restart payments' }],
    });
    expect(
      thread(assistant({ type: 'text', text: 'Done **now**.' })),
    ).toMatchObject({
      id: 'run_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done **now**.' }],
    });
  });

  it('gives a user message its images as attachments that carry our attachment and no URL', () => {
    const images = [
      { id: 'att-1', mediaType: 'image/png', name: 'a.png', size: 4 },
      { id: 'att-2', mediaType: 'image/jpeg', name: 'b.jpg', size: 5 },
    ];
    const message: ChatUiMessage = {
      id: 'item_2',
      role: 'user',
      parts: [{ type: 'text', text: '' }],
      metadata: { attachments: images },
    };
    const converted = thread(message);
    expect(converted.attachments).toHaveLength(2);
    expect(converted.attachments?.map(a => [a.id, a.type, a.name])).toEqual([
      ['att-1', 'image', 'a.png'],
      ['att-2', 'image', 'b.jpg'],
    ]);
    expect(converted.attachments?.map(chatAttachmentOf)).toEqual(images);
    expect(JSON.stringify(converted.attachments)).not.toMatch(
      /blob:|http|data:/,
    );
    expect(thread({ ...message, metadata: undefined }).attachments).toEqual([]);
  });

  it('leaves out step boundaries and reasoning, and keeps the order of the rest', () => {
    const message = assistant(
      { type: 'step-start' },
      { type: 'reasoning', text: 'thinking', state: 'done' },
      { type: 'text', text: 'first' },
      tool({ state: 'output-available', output: { ok: true } }),
      { type: 'step-start' },
      { type: 'text', text: 'second' },
    );
    expect(thread(message).content.map(p => p.type)).toEqual([
      'text',
      'tool-call',
      'text',
    ]);
  });

  it('streams: a text and a call whose input is not complete', () => {
    const message = assistant(
      { type: 'text', text: 'Let me', state: 'streaming' },
      tool({ state: 'input-streaming', input: undefined }),
    );
    const converted = thread(message);
    expect(converted.content[0]).toMatchObject({
      type: 'text',
      text: 'Let me',
    });
    const call = onlyCall(message);
    expect(call).toMatchObject({
      toolCallId: 'c1',
      toolName: 'dev-actions:restart-service',
      args: {},
    });
    expect(call.result).toBeUndefined();
    expect(call.approval).toBeUndefined();
  });

  it('a call that runs without a decision: input, then the result', () => {
    const running = onlyCall(assistant(tool({ state: 'input-available' })));
    expect(running.args).toEqual({ name: 'payments' });
    expect(running.argsText).toBe('{"name":"payments"}');
    expect(running.result).toBeUndefined();

    const done = onlyCall(
      assistant(tool({ state: 'output-available', output: { restarts: 1 } })),
    );
    expect(done.result).toEqual({ restarts: 1 });
    expect(done.isError).toBeFalsy();
    expect(done.approval).toBeUndefined();
  });

  it('waits for approval: the approval has the id and no decision', () => {
    const call = onlyCall(
      assistant(tool({ state: 'approval-requested', approval: { id: 'c1' } })),
    );
    expect(call.approval).toEqual({ id: 'c1' });
    expect(call.result).toBeUndefined();
  });

  it('after the approval: allowed with no result yet, then the result', () => {
    const allowed = onlyCall(
      assistant(
        tool({
          state: 'approval-responded',
          approval: { id: 'c1', approved: true },
        }),
      ),
    );
    expect(allowed.approval).toEqual({ id: 'c1', approved: true });
    expect(allowed.result).toBeUndefined();

    const done = onlyCall(
      assistant(
        tool({
          state: 'output-available',
          output: { ok: true },
          approval: { id: 'c1', approved: true },
        }),
      ),
    );
    expect(done.approval).toEqual({ id: 'c1', approved: true });
    expect(done.result).toEqual({ ok: true });
  });

  it('rejected: denied before or after the run asked again', () => {
    for (const state of ['approval-responded', 'output-denied']) {
      const call = onlyCall(
        assistant(
          tool({
            state,
            approval: { id: 'c1', approved: false, reason: 'no' },
          }),
        ),
      );
      expect(call.approval).toEqual({
        id: 'c1',
        approved: false,
        reason: 'no',
      });
      expect(call.result).toBeUndefined();
    }
  });

  it('a call that failed, whose result is not known, or that did not run', () => {
    for (const errorText of ['boom', RESULT_NOT_KNOWN, NOT_RUN]) {
      const call = onlyCall(
        assistant(tool({ state: 'output-error', errorText })),
      );
      expect(call.isError).toBe(true);
      expect(call.result).toBe(errorText);
    }
  });

  it('a failed run: the data-run part keeps its name and data', () => {
    const message = assistant(
      { type: 'text', text: 'partial' },
      { type: 'data-run', data: { runId: 'r1', status: 'failed' } },
    );
    expect(thread(message).content[1]).toMatchObject({
      type: 'data',
      name: 'run',
      data: { runId: 'r1', status: 'failed' },
    });
  });

  it('a notice and an inserted message keep their names, data and id', () => {
    const message = assistant(
      { type: 'data-notice', data: { code: 'summarizing', text: 'x' } },
      {
        type: 'data-inserted',
        id: 'inserted-4',
        data: { seq: 4, text: 'use the canary' },
      },
    );
    expect(thread(message).content).toMatchObject([
      { type: 'data', name: 'notice', data: { code: 'summarizing' } },
      {
        type: 'data',
        name: 'inserted',
        id: 'inserted-4',
        data: { seq: 4, text: 'use the canary' },
      },
    ]);
  });

  it('an inserted message that was not read: the user text and data-unread', () => {
    const message = {
      id: 'item_7',
      role: 'user',
      parts: [
        { type: 'text', text: 'also check the logs' },
        { type: 'data-unread', data: { seq: 7, sendAgain: true } },
      ],
    } as ChatUiMessage;
    expect(thread(message)).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'also check the logs' },
        { type: 'data', name: 'unread', data: { seq: 7, sendAgain: true } },
      ],
    });
  });

  it('uses the tool name of a dynamic tool', () => {
    expect(
      toToolCall({
        type: 'dynamic-tool',
        toolName: 'catalog:query',
        toolCallId: 'c2',
        state: 'input-available',
        input: {},
      } as unknown as ToolPart).toolName,
    ).toBe('catalog:query');
  });
});

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
  HarnessEvent,
  Item,
  ToolCallItem,
} from '@kwkevinchan/ai-chat-harness';
import type { HostEvent } from '../../../application';
import { TOOL_RESULT_NOT_KNOWN } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { readMessage, throughSdk } from '../__testUtils__/uiMessageStream';
import type { UiMessageChunk } from './uiMessageChunk';
import { UiMessageStreamPresenter } from './uiMessageStream';

const RUN = 'run-1';
const MESSAGE_ID = 'run_run-1';

const base = (seq: number) => ({
  sessionId: 's1',
  seq,
  runId: RUN,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const agentMessage = (seq: number, text: string): Item => ({
  ...base(seq),
  kind: 'agent_message',
  text,
});

const toolCall = (
  seq: number,
  callId: string,
  extra: Partial<ToolCallItem> = {},
): ToolCallItem => ({
  ...base(seq),
  kind: 'tool_call',
  callId,
  toolId: 'demo:write',
  input: { name: 'x' },
  schemaHash: 'h',
  policy: 'ask',
  readOnly: false,
  step: 1,
  position: 0,
  ...extra,
});

const toolResult = (
  seq: number,
  callId: string,
  extra: Record<string, unknown> = {},
): Item =>
  ({
    ...base(seq),
    kind: 'tool_result',
    callId,
    status: 'ok',
    output: { done: true },
    ...extra,
  } as Item);

const completed = (item: Item, draftId?: string): HarnessEvent => ({
  type: 'item.completed',
  ...(draftId && { draftId }),
  item,
});

function present(
  events: HostEvent[],
  options: ConstructorParameters<typeof UiMessageStreamPresenter>[0] = {
    runId: RUN,
  },
): UiMessageChunk[] {
  const presenter = new UiMessageStreamPresenter(options);
  return [...events.flatMap(e => presenter.present(e)), ...presenter.close()];
}

const types = (chunks: { type: string }[]) => chunks.map(c => c.type);

describe('UiMessageStreamPresenter', () => {
  it('streams an answer as text parts of one step, and finishes with stop', async () => {
    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'step.started', step: 1 },
      { type: 'item.started', draftId: 'd1', kind: 'agent_message' },
      { type: 'item.delta', draftId: 'd1', text: 'Hel' },
      { type: 'item.delta', draftId: 'd1', text: 'lo' },
      completed(agentMessage(2, 'Hello'), 'd1'),
      { type: 'step.ended', step: 1 },
      { type: 'run.ended', outcome: { status: 'completed' } },
    ]);
    expect(types(chunks)).toEqual([
      'start',
      'data-run',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'data-item',
      'finish-step',
      'data-run',
      'finish',
    ]);
    expect(chunks[0]).toEqual({ type: 'start', messageId: MESSAGE_ID });
    expect(chunks[chunks.length - 2]).toEqual({
      type: 'data-run',
      data: { runId: RUN, status: 'completed' },
      transient: true,
    });
    expect(chunks[chunks.length - 1]).toEqual({
      type: 'finish',
      finishReason: 'stop',
    });

    const message = await readMessage(await throughSdk(chunks));
    expect(message.id).toBe(MESSAGE_ID);
    expect(message.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'Hello', state: 'done' },
    ]);
  });

  it('sends the text of an item that arrives whole, and ignores a piece of an unknown draft', async () => {
    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'item.delta', draftId: 'unknown', text: 'lost' },
      completed(agentMessage(2, 'All of it')),
      { type: 'run.ended', outcome: { status: 'completed' } },
    ]);
    const message = await readMessage(await throughSdk(chunks));
    expect(message.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'All of it', state: 'done' },
    ]);
  });

  it('sends what a draft lacks when the complete item has more text', async () => {
    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'step.started', step: 1 },
      { type: 'item.started', draftId: 'd1', kind: 'agent_message' },
      { type: 'item.delta', draftId: 'd1', text: 'Hel' },
      completed(agentMessage(2, 'Hello'), 'd1'),
      { type: 'step.ended', step: 1 },
      { type: 'run.ended', outcome: { status: 'completed' } },
    ]);
    const message = await readMessage(await throughSdk(chunks));
    expect(message.parts[1]).toMatchObject({ type: 'text', text: 'Hello' });
  });

  it('shows a tool call when its item is complete, not when it starts', async () => {
    const started: HarnessEvent = {
      type: 'item.started',
      draftId: 'c1',
      kind: 'tool_call',
      modelCallId: 'model-id',
    };
    expect(
      new UiMessageStreamPresenter({ runId: RUN }).present(started),
    ).toEqual([]);

    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'step.started', step: 1 },
      started,
      completed(
        toolCall(2, 'c1', {
          toolId: 'demo:read',
          readOnly: true,
          policy: 'allow',
        }),
        'c1',
      ),
      { type: 'step.ended', step: 1 },
      completed({ ...base(3), kind: 'tool_started', callId: 'c1' } as Item),
      completed(toolResult(4, 'c1')),
      { type: 'run.ended', outcome: { status: 'completed' } },
    ]);
    expect(chunks.filter(c => c.type === 'tool-input-available')).toEqual([
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'demo:read',
        input: { name: 'x' },
      },
    ]);
    const message = await readMessage(await throughSdk(chunks));
    expect(message.parts[1]).toMatchObject({
      type: 'tool-demo:read',
      toolCallId: 'c1',
      state: 'output-available',
      input: { name: 'x' },
      output: { done: true },
    });
  });

  it('asks for the approval of every pending call before it ends the stream with tool-calls', async () => {
    const a = toolCall(2, 'a');
    const b = toolCall(3, 'b', { readOnly: true });
    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'step.started', step: 1 },
      completed(a),
      completed(b),
      { type: 'step.ended', step: 1 },
      {
        type: 'run.ended',
        outcome: { status: 'waiting_approval', pending: [a, b] },
      },
    ]);
    const tail = chunks.slice(-4);
    expect(tail.slice(0, 3)).toEqual([
      {
        type: 'tool-approval-request',
        approvalId: 'a',
        toolCallId: 'a',
        reason: 'The action is not read-only.',
      },
      {
        type: 'tool-approval-request',
        approvalId: 'b',
        toolCallId: 'b',
        reason: 'The policy asks for approval.',
      },
      {
        type: 'data-run',
        data: { runId: RUN, status: 'waiting_approval' },
        transient: true,
      },
    ]);
    expect(types(tail)).toEqual([
      'tool-approval-request',
      'tool-approval-request',
      'data-run',
      'finish',
    ]);
    expect(tail[3]).toEqual({ type: 'finish', finishReason: 'tool-calls' });

    const message = await readMessage(await throughSdk(chunks));
    expect(message.parts.filter(p => p.type === 'tool-demo:write')).toEqual([
      expect.objectContaining({
        toolCallId: 'a',
        state: 'approval-requested',
        approval: {
          id: 'a',
          requestReason: 'The action is not read-only.',
        },
      }),
      expect.objectContaining({
        toolCallId: 'b',
        state: 'approval-requested',
      }),
    ]);
  });

  it.each([
    [true, 'output-available', toolResult(5, 'a')],
    [
      false,
      'output-denied',
      toolResult(5, 'a', { status: 'denied', output: undefined }),
    ],
  ])(
    'continues the message after an approval (approved: %s): the decision comes first, then the result',
    async (approved, state, result) => {
      const a = toolCall(2, 'a');
      const first = present([
        { type: 'run.started', runId: RUN },
        { type: 'step.started', step: 1 },
        completed(a),
        { type: 'step.ended', step: 1 },
        {
          type: 'run.ended',
          outcome: { status: 'waiting_approval', pending: [a] },
        },
      ]);
      const before = await readMessage(await throughSdk(first));

      const second = present(
        [
          { type: 'run.started', runId: RUN },
          { type: 'step.started', step: 2 },
          completed(result),
          completed(agentMessage(6, 'Done.')),
          { type: 'step.ended', step: 2 },
          { type: 'run.ended', outcome: { status: 'completed' } },
        ],
        {
          runId: RUN,
          afterStart: [
            { type: 'tool-approval-response', approvalId: 'a', approved },
          ],
        },
      );
      expect(types(second).slice(0, 3)).toEqual([
        'start',
        'tool-approval-response',
        'data-run',
      ]);
      expect(second[0]).toEqual({ type: 'start', messageId: MESSAGE_ID });

      const after = await readMessage(await throughSdk(second), before);
      expect(after.id).toBe(MESSAGE_ID);
      expect(after.parts.find(p => p.type === 'tool-demo:write')).toMatchObject(
        {
          toolCallId: 'a',
          state,
          approval: { id: 'a', approved },
        },
      );
      expect(after.parts[after.parts.length - 1]).toMatchObject({
        type: 'text',
        text: 'Done.',
      });
    },
  );

  it.each([
    ['timeout', 'The tool call timed out.', undefined],
    ['invalid', 'The input of the tool call is not valid.', undefined],
    ['unknown', TOOL_RESULT_NOT_KNOWN, undefined],
    // The text of the tool never replaces the mark that the screen knows.
    ['unknown', TOOL_RESULT_NOT_KNOWN, 'lost in a crash'],
    ['error', 'The tool call failed.', undefined],
    [
      'invalid',
      'must have required property name',
      'must have required property name',
    ],
  ])(
    'shows a result with status %s as an error text',
    async (status, text, message) => {
      const chunks = present([
        { type: 'run.started', runId: RUN },
        completed(toolCall(2, 'a')),
        completed(toolResult(3, 'a', { status, output: undefined, message })),
        { type: 'run.ended', outcome: { status: 'completed' } },
      ]);
      expect(chunks.find(c => c.type === 'tool-output-error')).toEqual({
        type: 'tool-output-error',
        toolCallId: 'a',
        errorText: text,
      });
      const message2 = await readMessage(await throughSdk(chunks));
      expect(
        message2.parts.find(p => p.type === 'tool-demo:write'),
      ).toMatchObject({
        state: 'output-error',
        errorText: text,
      });
    },
  );

  it('ends a failed run with the state and then the error, with no finish, and never shows the cause', async () => {
    const cause = new Error('provider said: key sk-secret-123 is invalid');
    const chunks = present([
      { type: 'run.started', runId: RUN },
      {
        type: 'run.ended',
        outcome: { status: 'failed', message: 'The model call failed.', cause },
      },
    ]);
    expect(types(chunks)).toEqual(['start', 'data-run', 'data-run', 'error']);
    expect(chunks.slice(-2)).toEqual([
      {
        type: 'data-run',
        data: { runId: RUN, status: 'failed' },
        transient: true,
      },
      { type: 'error', errorText: 'The model call failed.' },
    ]);
    expect(JSON.stringify(chunks)).not.toContain('sk-secret');
    expect(JSON.stringify(chunks)).not.toContain('provider said');
    await throughSdk(chunks);
  });

  it('ends a cancelled run with the state and then abort', async () => {
    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'step.started', step: 1 },
      { type: 'item.started', draftId: 'd1', kind: 'agent_message' },
      { type: 'item.delta', draftId: 'd1', text: 'Par' },
      { type: 'run.ended', outcome: { status: 'cancelled' } },
    ]);
    // The open text part and the open step are closed before the end.
    expect(types(chunks)).toEqual([
      'start',
      'data-run',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'data-run',
      'abort',
    ]);
    expect(chunks[chunks.length - 2]).toMatchObject({
      data: { status: 'cancelled' },
    });
    await throughSdk(chunks);
  });

  it('reports the end reason of a run a limit stopped', () => {
    const chunks = present([
      { type: 'run.started', runId: RUN },
      {
        type: 'run.ended',
        outcome: { status: 'completed', endReason: 'max_steps' },
      },
    ]);
    expect(chunks.filter(c => c.type === 'data-run').pop()).toEqual({
      type: 'data-run',
      data: { runId: RUN, status: 'completed', endReason: 'max_steps' },
      transient: true,
    });
  });

  describe('inserted messages and the queue (PI-03)', () => {
    const inserted = (seq: number, text = 'inserted'): Item =>
      ({
        ...base(seq),
        kind: 'user_message',
        text,
        delivery: 'inserted',
      } as Item);
    const output = (seq: number, readUpToSeq: number): Item =>
      ({ ...agentMessage(seq, 'ok'), readUpToSeq } as Item);

    it('sends data-inserted for message.read before the step that read it, as a part of the message', async () => {
      const chunks = present([
        { type: 'run.started', runId: RUN },
        { type: 'message.read', item: inserted(3, 'Use the staging one') },
        { type: 'step.started', step: 2 },
        completed(output(5, 3)),
        { type: 'step.ended', step: 2 },
        { type: 'run.ended', outcome: { status: 'completed' } },
      ]);
      const at = (type: string) => chunks.findIndex(c => c.type === type);
      expect(chunks[at('data-inserted')]).toEqual({
        type: 'data-inserted',
        id: 'inserted-3',
        data: { seq: 3, text: 'Use the staging one' },
      });
      expect(at('data-inserted')).toBeLessThan(at('start-step'));
      // Not transient: the SDK keeps it in the message.
      const message = await readMessage(await throughSdk(chunks));
      expect(
        message.parts.filter(part => part.type === 'data-inserted'),
      ).toEqual([
        {
          type: 'data-inserted',
          id: 'inserted-3',
          data: { seq: 3, text: 'Use the staging one' },
        },
      ]);
    });

    it('does not drop a message that was written before the output the stream already sent (its seq is lower)', () => {
      // The output with seq 4 went out; the inserted message has seq 3.
      const presenter = new UiMessageStreamPresenter({ runId: RUN });
      presenter.present(completed(output(4, 2)));
      const chunks = presenter.present({
        type: 'message.read',
        item: inserted(3),
      });
      expect(types(chunks)).toEqual(['data-inserted']);
    });

    it('sends each inserted message once', () => {
      const presenter = new UiMessageStreamPresenter({ runId: RUN });
      const event = { type: 'message.read', item: inserted(3) } as const;
      expect(types(presenter.present(event))).toEqual(['data-inserted']);
      expect(presenter.present(event)).toEqual([]);
    });

    it('sends data-inserted in a replay before the output that read the message, and not again for the live event', () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      const log: Item[] = [
        { ...base(1), kind: 'user_message', text: 'go' } as Item,
        output(2, 1),
        inserted(3),
        output(4, 3),
        inserted(5, 'not read yet'),
      ];
      const head = presenter.replay('running', log, 5);
      const inserts = head.filter(c => c.type === 'data-inserted');
      // Only the message that an output read; the later one is not shown yet.
      expect(inserts).toEqual([
        {
          type: 'data-inserted',
          id: 'inserted-3',
          data: { seq: 3, text: 'inserted' },
        },
      ]);
      const insertAt = head.findIndex(c => c.type === 'data-inserted');
      const outputsAfter = head
        .slice(insertAt)
        .filter(c => c.type === 'text-start');
      expect(outputsAfter).toHaveLength(1);
      // The live event of the message the replay sent adds nothing; the other
      // one is sent when the model reads it.
      expect(
        presenter.present({ type: 'message.read', item: inserted(3) }),
      ).toEqual([]);
      expect(
        types(presenter.present({ type: 'message.read', item: inserted(5) })),
      ).toEqual(['data-inserted']);
    });

    it('sends a message whose message.read came before the stream, with the output that read it', () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      const log: Item[] = [
        { ...base(1), kind: 'user_message', text: 'go' } as Item,
        output(2, 1),
        inserted(3, 'late idea'),
      ];
      // The replay has no output that read message 3.
      const head = presenter.replay('running', log, 3, log);
      expect(head.filter(c => c.type === 'data-inserted')).toEqual([]);

      const live = presenter.present(completed(output(4, 3)));
      expect(live.filter(c => c.type === 'data-inserted')).toEqual([
        {
          type: 'data-inserted',
          id: 'inserted-3',
          data: { seq: 3, text: 'late idea' },
        },
      ]);
      // Before the text of the output that read it, and only once.
      expect(types(live).indexOf('data-inserted')).toBeLessThan(
        types(live).indexOf('text-start'),
      );
      expect(
        presenter.present({ type: 'message.read', item: inserted(3) }),
      ).toEqual([]);
      expect(
        presenter
          .present(completed(output(5, 3)))
          .filter(c => c.type === 'data-inserted'),
      ).toEqual([]);
    });

    it('sends it also when afterSeq left the message out of the replay', () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      // The items after seq 3 are none; the host still hands over message 3.
      const head = presenter.replay('running', [], 3, [
        inserted(3, 'late idea'),
      ]);
      expect(head.filter(c => c.type === 'data-inserted')).toEqual([]);
      const live = presenter.present(completed(output(4, 3)));
      expect(live.filter(c => c.type === 'data-inserted')).toHaveLength(1);
    });

    it('does not hold a message for an output that did not read it', () => {
      const presenter = new UiMessageStreamPresenter({ runId: RUN });
      presenter.replay('running', [], 3, [inserted(3)]);
      expect(
        presenter
          .present(completed(output(4, 2)))
          .filter(c => c.type === 'data-inserted'),
      ).toEqual([]);
    });

    it('sends the queue as a transient data-queue before the state of the run', async () => {
      const queued = {
        id: 'q1',
        sessionId: 's1',
        position: 1,
        text: 'Next',
        attachments: [],
        createdAt: 'x',
        updatedAt: 'x',
      };
      const chunks = present([
        { type: 'run.started', runId: RUN },
        {
          type: 'queue.state',
          items: [queued],
          paused: false,
          nextRunId: 'run-2',
        },
        { type: 'run.ended', outcome: { status: 'completed' } },
      ]);
      expect(types(chunks)).toEqual([
        'start',
        'data-run',
        'data-queue',
        'data-run',
        'finish',
      ]);
      expect(chunks[2]).toEqual({
        type: 'data-queue',
        transient: true,
        // The shape of `GET /queue`: no `sessionId`.
        data: {
          items: [
            {
              id: 'q1',
              position: 1,
              text: 'Next',
              attachments: [],
              createdAt: 'x',
              updatedAt: 'x',
            },
          ],
          paused: false,
          nextRunId: 'run-2',
        },
      });
      await throughSdk(chunks);
    });
  });

  it('turns the summary and the trimming of the context into notices, one for the trimming, and shows no summary message', async () => {
    const summary = {
      ...base(2),
      kind: 'summary',
      coversUpToSeq: 1,
      text: 'The summary text',
    } as Item;
    const chunks = present([
      { type: 'run.started', runId: RUN },
      { type: 'summary.started', coversUpToSeq: 1 },
      completed(summary),
      { type: 'summary.failed', cause: new Error('model server says: boom') },
      { type: 'context.trimmed', parts: ['earlier'] },
      { type: 'context.trimmed', parts: ['steps'] },
      { type: 'run.ended', outcome: { status: 'completed' } },
    ]);
    expect(chunks.filter(c => c.type === 'data-notice')).toEqual([
      {
        type: 'data-notice',
        data: {
          code: 'summarizing',
          text: 'Summarizing the earlier part of the conversation.',
        },
        transient: true,
      },
      {
        type: 'data-notice',
        data: {
          code: 'context_trimmed',
          text: 'Earlier content was left out.',
        },
        transient: true,
      },
    ]);
    expect(chunks.find(c => c.type === 'data-item')).toEqual({
      type: 'data-item',
      data: { seq: 2, kind: 'summary' },
      transient: true,
    });
    const json = JSON.stringify(chunks);
    expect(json).not.toContain('The summary text');
    expect(json).not.toContain('boom');
    const message = await readMessage(await throughSdk(chunks));
    expect(message.parts).toEqual([]);
  });

  it('shows the plan with a fixed id, and every item with its seq and kind', async () => {
    const plan = (seq: number, text: string): Item =>
      ({
        ...base(seq),
        kind: 'plan_update',
        plan: { items: [{ text, status: 'pending' }] },
      } as Item);
    const chunks = present([
      { type: 'run.started', runId: RUN },
      completed(plan(2, 'one')),
      completed(plan(3, 'two')),
      { type: 'run.ended', outcome: { status: 'completed' } },
    ]);
    expect(chunks.filter(c => c.type === 'data-plan')).toEqual([
      {
        type: 'data-plan',
        id: 'plan',
        data: { items: [{ text: 'one', status: 'pending' }] },
      },
      {
        type: 'data-plan',
        id: 'plan',
        data: { items: [{ text: 'two', status: 'pending' }] },
      },
    ]);
    const message = await readMessage(await throughSdk(chunks));
    const plans = message.parts.filter(p => p.type === 'data-plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ data: { items: [{ text: 'two' }] } });
    expect(
      chunks.filter(c => c.type === 'data-item').map(c => (c as any).data),
    ).toEqual([
      { seq: 2, kind: 'plan_update' },
      { seq: 3, kind: 'plan_update' },
    ]);
  });

  it('says the run stopped when the events end without run.ended', async () => {
    const chunks = present([{ type: 'run.started', runId: RUN }]);
    expect(chunks.slice(-2)).toEqual([
      {
        type: 'data-run',
        data: { runId: RUN, status: 'failed' },
        transient: true,
      },
      { type: 'error', errorText: 'The run stopped.' },
    ]);
  });

  describe('replay for a client that joins a run under way (A-07)', () => {
    const items: Item[] = [
      { ...base(1), kind: 'user_message', text: 'hi' },
      agentMessage(2, 'Let me check.'),
      toolCall(3, 'a', {
        readOnly: true,
        policy: 'allow',
        toolId: 'demo:read',
      }),
      { ...base(4), kind: 'tool_started', callId: 'a' } as Item,
      toolResult(5, 'a'),
    ];

    it('starts with the same message id, replays the run from its first item and goes on with the new events', async () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      const head = presenter.replay('running', items, 5);
      expect(head[0]).toEqual({ type: 'start', messageId: MESSAGE_ID });
      expect(head[1]).toMatchObject({
        type: 'data-run',
        data: { status: 'running' },
      });

      const live: HarnessEvent[] = [
        // Events of items that are in the replay already, and a draft that began
        // before the client joined: skipped.
        completed(toolResult(5, 'a')),
        { type: 'item.delta', draftId: 'old', text: 'x' },
        { type: 'step.started', step: 2 },
        { type: 'item.started', draftId: 'd2', kind: 'agent_message' },
        { type: 'item.delta', draftId: 'd2', text: 'Done' },
        completed(agentMessage(6, 'Done.'), 'd2'),
        { type: 'step.ended', step: 2 },
        { type: 'run.ended', outcome: { status: 'completed' } },
      ];
      const chunks = [
        ...head,
        ...live.flatMap(e => presenter.present(e)),
        ...presenter.close(),
      ];
      const message = await readMessage(await throughSdk(chunks));
      expect(message.id).toBe(MESSAGE_ID);
      expect(message.parts).toEqual([
        { type: 'step-start' },
        { type: 'text', text: 'Let me check.', state: 'done' },
        expect.objectContaining({
          type: 'tool-demo:read',
          toolCallId: 'a',
          state: 'output-available',
        }),
        { type: 'step-start' },
        { type: 'text', text: 'Done.', state: 'done' },
      ]);
      // Every item went out once.
      expect(
        chunks
          .filter(c => c.type === 'data-item')
          .map(c => (c as any).data.seq),
      ).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('asks for the approval of a call before its decision, so the SDK finds the part (a run that was approved and goes on)', async () => {
      const write = toolCall(3, 'w');
      const log: Item[] = [
        { ...base(1), kind: 'user_message', text: 'change it' },
        agentMessage(2, 'Changing.'),
        write,
        {
          ...base(4),
          kind: 'approval',
          callId: 'w',
          decision: 'allow',
          decidedBy: 'user:default/jane',
        } as Item,
        { ...base(5), kind: 'tool_started', callId: 'w' } as Item,
        toolResult(6, 'w'),
      ];
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      const chunks = [
        ...presenter.replay('running', log, 6),
        ...[
          { type: 'step.ended', step: 1 },
          { type: 'run.ended', outcome: { status: 'completed' } },
        ].flatMap(e => presenter.present(e as HarnessEvent)),
        ...presenter.close(),
      ];
      const chunkTypes = chunks.map(c => c.type);
      expect(chunkTypes.indexOf('tool-approval-request')).toBeGreaterThan(-1);
      expect(chunkTypes.indexOf('tool-approval-request')).toBeLessThan(
        chunkTypes.indexOf('tool-approval-response'),
      );
      // The SDK throws when a decision has no request before it.
      const message = await readMessage(await throughSdk(chunks));
      expect(
        message.parts.find(p => p.type === 'tool-demo:write'),
      ).toMatchObject({
        state: 'output-available',
        approval: { id: 'w', approved: true },
        output: { done: true },
      });
    });

    it('does not send an empty step for the step events of a step that was replayed', async () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      const head = presenter.replay('running', items, 5);
      const live = [
        // The queue holds the events of step 1, which the replay covered.
        { type: 'step.started', step: 1 },
        { type: 'step.ended', step: 1 },
        { type: 'step.started', step: 2 },
        { type: 'step.ended', step: 2 },
      ].flatMap(e => presenter.present(e as HarnessEvent));
      expect(head.filter(c => c.type === 'start-step')).toHaveLength(1);
      // Only step 2 is new; it is empty, so it opens and closes once.
      expect(live.map(c => c.type)).toEqual(['start-step', 'finish-step']);
      expect(head.filter(c => c.type === 'finish-step')).toHaveLength(1);
    });

    it('does not open another step for the step events of a step that has only an answer', () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      // Step 1 wrote text and no call, so the log has no step number for it.
      const head = presenter.replay(
        'running',
        [
          { ...base(1), kind: 'user_message', text: 'hi' },
          agentMessage(2, 'The answer.'),
        ] as Item[],
        2,
      );
      expect(head.filter(c => c.type === 'start-step')).toHaveLength(1);

      const live = [
        { type: 'step.started', step: 1 },
        { type: 'step.ended', step: 1 },
      ].flatMap(e => presenter.present(e as HarnessEvent));
      expect(live).toEqual([]);
      // The next step closes the open one and opens its own.
      expect(
        presenter
          .present({ type: 'step.started', step: 2 } as HarnessEvent)
          .map(c => c.type),
      ).toEqual(['finish-step', 'start-step']);
    });

    it('skips the end of a replayed step that is still open, and closes it with the next step', () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      // The log ends with the call of step 1: the replay leaves step 1 open.
      const head = presenter.replay(
        'running',
        [
          { ...base(1), kind: 'user_message', text: 'hi' },
          agentMessage(2, 'Thinking.'),
          toolCall(3, 'a', { readOnly: true, policy: 'allow' }),
        ] as Item[],
        3,
      );
      expect(head.filter(c => c.type === 'finish-step')).toHaveLength(0);

      expect(
        presenter.present({ type: 'step.ended', step: 1 } as HarnessEvent),
      ).toEqual([]);
      expect(
        presenter
          .present({ type: 'step.started', step: 2 } as HarnessEvent)
          .map(c => c.type),
      ).toEqual(['finish-step', 'start-step']);
      // The end of a step that was not replayed closes it.
      expect(
        presenter
          .present({ type: 'step.ended', step: 2 } as HarnessEvent)
          .map(c => c.type),
      ).toEqual(['finish-step']);
    });

    it('continues an open draft from the text it was given, and does not send that text again', async () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      const head = [
        ...presenter.replay(
          'running',
          [{ ...base(1), kind: 'user_message', text: 'hi' }] as Item[],
          1,
        ),
        ...presenter.resumeDraft('d1', 'Hel'),
      ];
      const live: HarnessEvent[] = [
        { type: 'item.delta', draftId: 'd1', text: 'lo' },
        completed(agentMessage(2, 'Hello'), 'd1'),
        { type: 'run.ended', outcome: { status: 'completed' } },
      ];
      const chunks = [
        ...head,
        ...live.flatMap(event => presenter.present(event)),
        ...presenter.close(),
      ];
      expect(chunks.filter(chunk => chunk.type === 'text-start')).toEqual([
        { type: 'text-start', id: 'd1' },
      ]);
      expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([
        { type: 'text-delta', id: 'd1', delta: 'Hel' },
        { type: 'text-delta', id: 'd1', delta: 'lo' },
      ]);
      const message = await readMessage(await throughSdk(chunks));
      expect(message.parts.filter(part => part.type === 'text')).toEqual([
        { type: 'text', text: 'Hello', state: 'done' },
      ]);
    });

    it('skips the events of items the log had when it was read, also those left out by afterSeq', () => {
      const presenter = new UiMessageStreamPresenter({
        runId: RUN,
        typing: false,
      });
      presenter.replay('running', [], 5);
      expect(presenter.present(completed(toolResult(5, 'a')))).toEqual([]);
      expect(
        presenter.present(completed(agentMessage(6, 'new'))).map(c => c.type),
      ).toContain('text-end');
    });
  });
});

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

import { messageIdOfRun } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { answer, call, detail, inserted, items, run, user } from '../testData';
import {
  decisionsOf,
  lastRunInterrupted,
  lastUserText,
  itemsToMessages,
} from './itemsToMessages';

const text = (t: string) => ({ kind: 'agent_message' as const, text: t });

function toolParts(messages: ReturnType<typeof itemsToMessages>) {
  return messages
    .flatMap(m => m.parts)
    .filter(p => p.type.startsWith('tool-')) as any[];
}

describe('itemsToMessages', () => {
  it('makes one assistant message for a run, with the id of the run', () => {
    const messages = itemsToMessages(
      detail({ items: items(user('hi'), text('Hello'), user('again')) }),
    );
    expect(messages.map(m => [m.id, m.role])).toEqual([
      ['item_1', 'user'],
      [messageIdOfRun('r-1'), 'assistant'],
      ['item_3', 'user'],
    ]);
    expect(messages[1].parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'Hello', state: 'done' },
    ]);
  });

  it('gives each run its own message and ignores summary and note items', () => {
    const messages = itemsToMessages(
      detail({
        items: items(
          user('a'),
          text('one'),
          { kind: 'summary', coversUpToSeq: 2, text: 'S' },
          { ...user('b'), runId: 'r-2' },
          { ...text('two'), runId: 'r-2' },
          { kind: 'note', text: 'n', runId: 'r-2' },
        ),
      }),
    );
    expect(messages.map(m => m.id)).toEqual([
      'item_1',
      'run_r-1',
      'item_4',
      'run_r-2',
    ]);
    expect(JSON.stringify(messages)).not.toContain('"S"');
  });

  it('groups items without runId by turn so forked assistant replies and plans render', () => {
    const t = '2026-11-26T00:00:00.000Z';
    const plan = {
      items: [{ text: 'Check status', status: 'completed' as const }],
    };
    const messages = itemsToMessages(
      detail({
        items: [
          {
            sessionId: 's-1',
            seq: 1,
            createdAt: t,
            kind: 'user_message',
            text: 'first q',
          },
          {
            sessionId: 's-1',
            seq: 2,
            createdAt: t,
            kind: 'agent_message',
            text: 'first a',
          },
          { sessionId: 's-1', seq: 3, createdAt: t, kind: 'plan_update', plan },
          {
            sessionId: 's-1',
            seq: 4,
            createdAt: t,
            kind: 'user_message',
            text: 'second q',
          },
          {
            sessionId: 's-1',
            seq: 5,
            createdAt: t,
            kind: 'agent_message',
            text: 'second a',
          },
        ],
      }),
    );

    expect(messages.map(m => [m.id, m.role])).toEqual([
      ['item_1', 'user'],
      ['turn_1', 'assistant'],
      ['item_4', 'user'],
      ['turn_4', 'assistant'],
    ]);
    expect(new Set(messages.map(m => m.id)).size).toBe(4);
    expect(messages[1].parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'first a', state: 'done' },
      { type: 'data-plan', id: 'plan', data: plan },
    ]);
    expect(messages[3].parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'second a', state: 'done' },
    ]);
  });

  it('shows a call that waits as approval-requested with approval.id = callId', () => {
    const messages = itemsToMessages(
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('go'), call('c1')),
      }),
    );
    expect(toolParts(messages)).toEqual([
      {
        type: 'tool-dev-actions:restart-service',
        toolCallId: 'c1',
        input: { name: 'payments' },
        state: 'approval-requested',
        approval: { id: 'c1' },
      },
    ]);
  });

  it('shows the decided call as approval-responded and the other as requested', () => {
    const messages = itemsToMessages(
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c2'],
        items: items(user('go'), call('c1'), call('c2'), {
          kind: 'approval',
          callId: 'c1',
          decision: 'allow',
          decidedBy: 'user:default/guest',
        }),
      }),
    );
    expect(
      toolParts(messages).map(p => [p.toolCallId, p.state, p.approval]),
    ).toEqual([
      ['c1', 'approval-responded', { id: 'c1', approved: true }],
      ['c2', 'approval-requested', { id: 'c2' }],
    ]);
  });

  it('shows a rejected decision that waits for the others as approval-responded, not approved', () => {
    const messages = itemsToMessages(
      detail({
        run: run('waiting_approval'),
        awaitingDecision: [],
        resumable: true,
        items: items(user('go'), call('c1'), {
          kind: 'approval',
          callId: 'c1',
          decision: 'deny',
          decidedBy: 'u',
        }),
      }),
    );
    expect(toolParts(messages)[0]).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'c1', approved: false },
    });
  });

  it('shows results: ok, error, denied and unknown', () => {
    const result = (callId: string, status: string, extra = {}) => ({
      kind: 'tool_result' as const,
      callId,
      status: status as never,
      ...extra,
    });
    const messages = itemsToMessages(
      detail({
        items: items(
          user('go'),
          call('a', 'x:read'),
          call('b', 'x:read'),
          call('c', 'x:read'),
          call('d', 'x:read'),
          result('a', 'ok', { output: { n: 1 } }),
          result('b', 'error', { message: 'boom' }),
          { kind: 'approval', callId: 'c', decision: 'deny', decidedBy: 'u' },
          result('c', 'denied'),
          result('d', 'unknown'),
        ),
      }),
    );
    expect(
      toolParts(messages).map(p => [
        p.toolCallId,
        p.state,
        p.output ?? p.errorText,
      ]),
    ).toEqual([
      ['a', 'output-available', { n: 1 }],
      ['b', 'output-error', 'boom'],
      ['c', 'output-denied', undefined],
      ['d', 'output-error', 'The result of the call is not known.'],
    ]);
    expect(toolParts(messages)[2].approval).toEqual({
      id: 'c',
      approved: false,
    });
  });

  it('shows a call of an ended run without result as unknown when it started, else as not run', () => {
    const messages = itemsToMessages(
      detail({
        items: items(
          user('go'),
          call('a'),
          call('b'),
          { kind: 'approval', callId: 'a', decision: 'allow', decidedBy: 'u' },
          { kind: 'tool_started', callId: 'a' },
        ),
      }),
    );
    expect(
      toolParts(messages).map(p => [p.toolCallId, p.state, p.errorText]),
    ).toEqual([
      ['a', 'output-error', 'The result of the call is not known.'],
      ['b', 'output-error', 'The call did not run.'],
    ]);
  });

  it('also shows a call without result as ended when the active run is another one', () => {
    const messages = itemsToMessages(
      detail({
        run: run('running', 'r-2'),
        items: items(user('go'), call('a')),
      }),
    );
    expect(toolParts(messages)[0]).toMatchObject({ state: 'output-error' });
  });

  it('shows a call of the active run without a decision or result as input-available', () => {
    const messages = itemsToMessages(
      detail({ run: run('running'), items: items(user('go'), call('a')) }),
    );
    expect(toolParts(messages)[0].state).toBe('input-available');
  });

  it('starts a step after the results, and keeps the last plan', () => {
    const messages = itemsToMessages(
      detail({
        items: items(
          user('go'),
          text('I will call'),
          call('a', 'x:read'),
          { kind: 'tool_result', callId: 'a', status: 'ok', output: 1 },
          text('Done'),
          {
            kind: 'plan_update',
            plan: { items: [{ text: 'p', status: 'pending' }] },
          },
          {
            kind: 'plan_update',
            plan: { items: [{ text: 'p', status: 'completed' }] },
          },
        ),
      }),
    );
    expect(messages[1].parts.map(p => p.type)).toEqual([
      'step-start',
      'text',
      'tool-x:read',
      'step-start',
      'text',
      'data-plan',
    ]);
    expect(messages[1].parts[5]).toMatchObject({
      id: 'plan',
      data: { items: [{ status: 'completed' }] },
    });
  });
});

describe('lastRunInterrupted', () => {
  it('is true when no run is active and the log does not end with an answer', () => {
    expect(lastRunInterrupted(detail({ items: items(user('a')) }))).toBe(true);
    expect(
      lastRunInterrupted(detail({ items: items(user('a'), call('x')) })),
    ).toBe(true);
  });
  it('is false after an answer, with an active run, and for an empty log', () => {
    expect(
      lastRunInterrupted(detail({ items: items(user('a'), text('b')) })),
    ).toBe(false);
    expect(
      lastRunInterrupted(
        detail({ run: run('running'), items: items(user('a')) }),
      ),
    ).toBe(false);
    expect(lastRunInterrupted(detail())).toBe(false);
  });
});

describe('decisionsOf', () => {
  it('names who decided each call and when', () => {
    expect(
      decisionsOf(
        items(user('a'), call('c1'), {
          kind: 'approval',
          callId: 'c1',
          decision: 'deny',
          decidedBy: 'user:default/guest',
        }),
      ),
    ).toEqual({
      c1: { by: 'user:default/guest', at: '2026-01-01T10:00:00.000Z' },
    });
  });
});

describe('lastUserText', () => {
  it('is the text of the last user message', () => {
    expect(lastUserText(items(user('a'), text('x'), user('b')))).toBe('b');
    expect(lastUserText([])).toBeUndefined();
  });
});

describe('inserted messages', () => {
  it('puts a message that was read before the step that read it, as a data-inserted part', () => {
    // seq: 1 user, 2 answer (read up to 1), 3 inserted, 4 answer (read up to 3)
    const messages = itemsToMessages(
      detail({
        items: items(
          user('start'),
          answer('first', 1),
          inserted('also this', 'read'),
          answer('second', 3),
        ),
      }),
    );
    expect(messages.map(m => m.id)).toEqual(['item_1', messageIdOfRun('r-1')]);
    expect(messages[1].parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'first', state: 'done' },
      {
        type: 'data-inserted',
        id: 'inserted-3',
        data: { seq: 3, text: 'also this' },
      },
      { type: 'step-start' },
      { type: 'text', text: 'second', state: 'done' },
    ]);
  });

  it('puts it before the tool call that read it, in the step of the call', () => {
    const messages = itemsToMessages(
      detail({
        items: items(user('start'), inserted('wait, use search', 'read'), {
          ...call('c1'),
          readUpToSeq: 2,
        } as never),
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
      }),
    );
    expect(messages[1].parts.map(p => p.type)).toEqual([
      'data-inserted',
      'step-start',
      'tool-dev-actions:restart-service',
    ]);
  });

  it('does not show a pending message in the conversation', () => {
    const messages = itemsToMessages(
      detail({
        run: run('running'),
        items: items(user('start'), inserted('later', 'pending')),
      }),
    );
    expect(messages.map(m => m.id)).toEqual(['item_1']);
    expect(JSON.stringify(messages)).not.toContain('later');
  });

  it('shows an unread message as a user message that says so', () => {
    const messages = itemsToMessages(
      detail({
        items: items(user('start'), inserted('too late', 'unread')),
      }),
    );
    expect(messages.map(m => [m.id, m.role])).toEqual([
      ['item_1', 'user'],
      ['item_2', 'user'],
    ]);
    expect(messages[1].parts).toEqual([
      { type: 'text', text: 'too late' },
      // The run has no answer: the run has the one button.
      {
        type: 'data-unread',
        id: 'unread-2',
        data: { seq: 2, sendAgain: false },
      },
    ]);
  });

  it('gives an unread message a button of its own when the run answered', () => {
    const messages = itemsToMessages(
      detail({
        items: items(
          user('start'),
          answer('done', 1),
          inserted('too late', 'unread'),
        ),
      }),
    );
    expect(messages[2].parts[1]).toEqual({
      type: 'data-unread',
      id: 'unread-3',
      data: { seq: 3, sendAgain: true },
    });
  });

  it('gives the button to the unread messages of the last run only', () => {
    const messages = itemsToMessages(
      detail({
        items: items(
          user('one'),
          answer('a', 1),
          inserted('old', 'unread'),
          { ...user('two'), runId: 'r-2' },
          answer('b', 4, 'r-2'),
          inserted('new', 'unread', 'r-2'),
        ),
      }),
    );
    const flags = messages
      .flatMap(m => m.parts)
      .filter(p => p.type === 'data-unread')
      .map(p => (p as any).data.sendAgain);
    expect(flags).toEqual([false, true]);
  });

  it('never makes two resend buttons: with no answer the run has one and no message has one', () => {
    const d = detail({
      items: items(
        user('start'),
        call('c1'),
        inserted('a', 'unread'),
        inserted('b', 'unread'),
      ),
    });
    expect(lastRunInterrupted(d)).toBe(true);
    const flags = itemsToMessages(d)
      .flatMap(m => m.parts)
      .filter(p => p.type === 'data-unread')
      .map(p => (p as any).data.sendAgain);
    expect(flags).toEqual([false, false]);
  });

  it('works out the state of an item the backend gave none', () => {
    const noState = (words: string) => ({
      ...inserted(words, 'read'),
      insertState: undefined,
    });
    const messages = itemsToMessages(
      detail({
        run: run('running'),
        items: items(
          user('start'),
          noState('read one'),
          answer('x', 2),
          noState('waits'),
        ),
      }),
    );
    expect(JSON.stringify(messages)).toContain('"data-inserted"');
    expect(JSON.stringify(messages)).not.toContain('waits');
  });
});

describe('the first message of the run (resend rules)', () => {
  it('lastUserText skips inserted messages', () => {
    expect(
      lastUserText(
        items(user('first'), answer('x', 1), inserted('b', 'unread')),
      ),
    ).toBe('first');
    expect(lastUserText(items(inserted('only', 'unread')))).toBeUndefined();
  });

  it('lastRunInterrupted is false when the run ended with its answer and an unread message follows', () => {
    expect(
      lastRunInterrupted(
        detail({
          items: items(user('a'), answer('b', 1), inserted('c', 'unread')),
        }),
      ),
    ).toBe(false);
  });

  it('lastRunInterrupted is true when the run has no answer, whatever was inserted after', () => {
    expect(
      lastRunInterrupted(
        detail({ items: items(user('a'), inserted('b', 'unread')) }),
      ),
    ).toBe(true);
    expect(
      lastRunInterrupted(
        detail({
          items: items(user('a'), call('c1'), inserted('b', 'unread')),
        }),
      ),
    ).toBe(true);
  });
});

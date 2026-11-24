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
import { call, detail, items, run, user } from '../testData';
import {
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

describe('lastUserText', () => {
  it('is the text of the last user message', () => {
    expect(lastUserText(items(user('a'), text('x'), user('b')))).toBe('b');
    expect(lastUserText([])).toBeUndefined();
  });
});

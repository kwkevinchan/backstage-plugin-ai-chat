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

import { act, renderHook, waitFor } from '@testing-library/react';
import {
  call,
  detail,
  items,
  jsonResponse,
  mockApi,
  run,
  streamResponse,
  user,
} from '../testData';
import { useSessionChat } from './useSessionChat';

const page = { path: '/ai-chat/s-1', entityRef: 'component:default/shop' };
const approver = {
  kind: 'approval' as const,
  decidedBy: 'user:default/guest',
};
const tool = 'tool-dev-actions:restart-service';

const text = (id: string, value: string) => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];

const runChunks = (status: string) => ({
  type: 'data-run',
  data: { runId: 'r-1', status },
  transient: true,
});

function render(api: ReturnType<typeof mockApi>, d = detail(), more = {}) {
  return renderHook(() => useSessionChat({ api, detail: d, page, ...more }));
}

/** A run that waits for two decisions, the first of them stored. */
const twoCalls = (decided: boolean) =>
  detail({
    run: run('waiting_approval'),
    awaitingDecision: decided ? ['c2'] : ['c1', 'c2'],
    items: items(
      user('restart both'),
      call('c1'),
      call('c2', 'dev-actions:restart-service', { name: 'search' }),
      ...(decided
        ? [{ ...approver, callId: 'c1', decision: 'allow' as const }]
        : []),
    ),
  });

function toolStates(result: { current: ReturnType<typeof useSessionChat> }) {
  return result.current.messages
    .flatMap(m => m.parts)
    .filter(p => p.type === tool)
    .map(p => [(p as any).toolCallId, (p as any).state]);
}

describe('useSessionChat', () => {
  it('sends the text with the page and shows the answer as it streams', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('running'),
        { type: 'start-step' },
        ...text('t1', 'Hello there'),
        { type: 'finish-step' },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = render(api);

    await act(() => result.current.send('hi'));

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'hi', page },
      expect.anything(),
    );
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(
      result.current.messages.map(m => [m.role, m.parts.map(p => p.type)]),
    ).toEqual([
      ['user', ['text']],
      ['assistant', ['step-start', 'text']],
    ]);
    expect(result.current.activeRun).toBeUndefined();
  });

  it('stores a decision that is not the last one at once and shows only that card changed', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(jsonResponse({ approved: true }));
    const { result } = render(api, twoCalls(false));
    expect(toolStates(result)).toEqual([
      ['c1', 'approval-requested'],
      ['c2', 'approval-requested'],
    ]);

    await act(() => result.current.decide('c1', true));

    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith('s-1', 'c1', {
      approved: true,
      page,
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(toolStates(result)).toEqual([
      ['c1', 'approval-responded'],
      ['c2', 'approval-requested'],
    ]);
    expect(result.current.awaiting).toEqual(['c2']);
  });

  it('sends only the last decision after a reload, not the stored one (P-04)', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        { type: 'tool-approval-response', approvalId: 'c2', approved: true },
        runChunks('running'),
        { type: 'start-step' },
        { type: 'tool-output-available', toolCallId: 'c1', output: { ok: 1 } },
        { type: 'tool-output-available', toolCallId: 'c2', output: { ok: 2 } },
        { type: 'finish-step' },
        { type: 'start-step' },
        ...text('t1', 'Both restarted'),
        { type: 'finish-step' },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = render(api, twoCalls(true));
    expect(toolStates(result)).toEqual([
      ['c1', 'approval-responded'],
      ['c2', 'approval-requested'],
    ]);

    await act(() => result.current.decide('c2', true));
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith(
      's-1',
      'c2',
      { approved: true, page },
      expect.anything(),
    );
    expect(toolStates(result)).toEqual([
      ['c1', 'output-available'],
      ['c2', 'output-available'],
    ]);
    // The answer goes on the same message.
    expect(
      result.current.messages.filter(m => m.role === 'assistant'),
    ).toHaveLength(1);
    expect(api.resume).not.toHaveBeenCalled();
  });

  it('reads who decided a call from the log: the decisions of the stored items, and one made here', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        { type: 'tool-approval-response', approvalId: 'c2', approved: true },
        { type: 'tool-output-available', toolCallId: 'c2', output: 1 },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    api.getSession.mockResolvedValue(
      detail({
        items: items(
          user('go'),
          call('c1'),
          call('c2'),
          {
            ...approver,
            callId: 'c1',
            decision: 'allow',
          },
          {
            ...approver,
            callId: 'c2',
            decision: 'allow',
          },
        ),
      }),
    );
    const { result } = render(api, twoCalls(true));
    // The stored decision is known at once.
    expect(result.current.decisions).toEqual({
      c1: { by: 'user:default/guest', at: '2026-01-01T10:00:00.000Z' },
    });

    await act(() => result.current.decide('c2', true));

    await waitFor(() =>
      expect(Object.keys(result.current.decisions).sort()).toEqual([
        'c1',
        'c2',
      ]),
    );
  });

  it('follows the run through the stream when the last decision got JSON', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(jsonResponse({ approved: true }));
    api.follow.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('running'),
        { type: 'start-step' },
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'dev-actions:restart-service',
          input: { name: 'payments' },
        },
        { type: 'tool-approval-request', approvalId: 'c1', toolCallId: 'c1' },
        { type: 'tool-approval-response', approvalId: 'c1', approved: true },
        { type: 'tool-output-available', toolCallId: 'c1', output: { ok: 1 } },
        { type: 'finish-step' },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const single = detail({
      run: run('waiting_approval'),
      awaitingDecision: ['c1'],
      items: items(user('restart'), call('c1')),
    });
    api.getSession.mockResolvedValue(
      detail({
        items: items(
          user('restart'),
          call('c1'),
          { ...approver, callId: 'c1', decision: 'allow' },
          {
            kind: 'tool_result',
            callId: 'c1',
            status: 'ok',
            output: { ok: 1 },
          },
        ),
      }),
    );
    const { result } = render(api, single);

    await act(() => result.current.decide('c1', true));

    await waitFor(() => expect(api.follow).toHaveBeenCalledTimes(1));
    // The SDK needs the whole run to find the tool parts: no afterSeq.
    expect(api.follow).toHaveBeenCalledWith('s-1', expect.anything());
    await waitFor(() =>
      expect(toolStates(result)).toEqual([['c1', 'output-available']]),
    );
    expect(api.resume).not.toHaveBeenCalled();
  });

  it('does not carry on by itself after a decision made here, whatever the stored state says', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(jsonResponse({ approved: true }));
    // Another request holds the lease, and the stored state still looks resumable.
    api.getSession.mockResolvedValue(
      detail({
        run: run('waiting_approval'),
        resumable: true,
        items: items(user('restart'), call('c1'), {
          ...approver,
          callId: 'c1',
          decision: 'allow',
        }),
      }),
    );
    const { result } = render(
      api,
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('restart'), call('c1')),
      }),
    );

    await act(() => result.current.decide('c1', true));
    await waitFor(() => expect(api.getSession).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(api.resume).not.toHaveBeenCalled();
    expect(toolStates(result)).toEqual([['c1', 'approval-responded']]);
  });

  it('carries on a run whose decisions are stored when the session opens', async () => {
    const api = mockApi();
    api.resume.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('running'),
        { type: 'start-step' },
        { type: 'tool-output-available', toolCallId: 'c1', output: { ok: 1 } },
        { type: 'finish-step' },
        { type: 'start-step' },
        ...text('t1', 'Restarted'),
        { type: 'finish-step' },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const stored = detail({
      run: run('waiting_approval'),
      resumable: true,
      items: items(user('restart'), call('c1'), {
        ...approver,
        callId: 'c1',
        decision: 'allow',
      }),
    });
    const { result } = render(api, stored);

    await waitFor(() =>
      expect(api.resume).toHaveBeenCalledWith(
        's-1',
        { page },
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(toolStates(result)).toEqual([['c1', 'output-available']]),
    );
    expect(
      result.current.messages.filter(m => m.role === 'assistant'),
    ).toHaveLength(1);
    // A run that waits has no stream to follow.
    expect(api.follow).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('carries a run on once when the last decision failed and the log says all decisions are stored (503)', async () => {
    const api = mockApi();
    api.decide.mockRejectedValue(new Error('Service Unavailable'));
    // The decision was stored; the backend was shutting down and did not start the loop.
    api.getSession.mockResolvedValue(
      detail({
        run: run('waiting_approval'),
        resumable: true,
        items: items(user('restart'), call('c1'), {
          ...approver,
          callId: 'c1',
          decision: 'allow',
        }),
      }),
    );
    api.resume.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('running'),
        { type: 'tool-output-available', toolCallId: 'c1', output: { ok: 1 } },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = render(
      api,
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('restart'), call('c1')),
      }),
    );

    await act(() => result.current.decide('c1', true));

    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toolStates(result)).toEqual([['c1', 'output-available']]),
    );
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('tries to carry on only once when the resume fails as well', async () => {
    const api = mockApi();
    api.decide.mockRejectedValue(new Error('Service Unavailable'));
    api.resume.mockRejectedValue(new Error('Service Unavailable'));
    api.getSession.mockResolvedValue(
      detail({
        run: run('waiting_approval'),
        resumable: true,
        items: items(user('restart'), call('c1'), {
          ...approver,
          callId: 'c1',
          decision: 'allow',
        }),
      }),
    );
    const { result } = render(
      api,
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('restart'), call('c1')),
      }),
    );

    await act(() => result.current.decide('c1', true));
    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(api.resume).toHaveBeenCalledTimes(1);
  });

  it('follows the run when the resume found nothing to carry on: another tab took it over', async () => {
    const api = mockApi();
    api.resume.mockResolvedValue(undefined);
    api.follow.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('running'),
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'dev-actions:restart-service',
          input: { name: 'payments' },
        },
        { type: 'tool-approval-request', approvalId: 'c1', toolCallId: 'c1' },
        { type: 'tool-approval-response', approvalId: 'c1', approved: true },
        { type: 'tool-output-available', toolCallId: 'c1', output: { ok: 1 } },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    api.getSession.mockResolvedValue(
      detail({
        items: items(
          user('restart'),
          call('c1'),
          { ...approver, callId: 'c1', decision: 'allow' },
          {
            kind: 'tool_result',
            callId: 'c1',
            status: 'ok',
            output: { ok: 1 },
          },
        ),
      }),
    );
    const { result } = render(
      api,
      detail({
        run: run('waiting_approval'),
        resumable: true,
        items: items(user('restart'), call('c1'), {
          ...approver,
          callId: 'c1',
          decision: 'allow',
        }),
      }),
    );
    expect(toolStates(result)).toEqual([['c1', 'approval-responded']]);

    await waitFor(() => expect(api.follow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toolStates(result)).toEqual([['c1', 'output-available']]),
    );
  });

  it('does not carry on by itself when the session is not resumable', async () => {
    const api = mockApi();
    render(api, twoCalls(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(api.resume).not.toHaveBeenCalled();
  });

  it('follows a run that goes on when the session opens, without afterSeq', async () => {
    const api = mockApi();
    api.follow.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('running'),
        { type: 'start-step' },
        ...text('t1', 'Partial and the rest'),
        { type: 'finish-step' },
        runChunks('completed'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const running = detail({
      run: run('running'),
      items: items(user('go'), { kind: 'agent_message', text: 'Partial' }),
    });
    const { result } = render(api, running);

    await waitFor(() =>
      expect(api.follow).toHaveBeenCalledWith('s-1', expect.anything()),
    );
    await waitFor(() => expect(result.current.activeRun).toBeUndefined());
    const assistant = result.current.messages.filter(
      m => m.role === 'assistant',
    );
    // The replay starts the message again: the stored text is not doubled.
    expect(assistant).toHaveLength(1);
    expect(assistant[0].parts.filter(p => p.type === 'text')).toHaveLength(1);
  });

  it('asks the backend to cancel the active run when the user stops it', async () => {
    const api = mockApi();
    api.getSession.mockResolvedValue(detail({ items: items(user('go')) }));
    const { result } = render(
      api,
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('go'), call('c1')),
      }),
    );
    expect(result.current.activeRun?.id).toBe('r-1');

    await act(() => result.current.stop());

    expect(api.cancelRun).toHaveBeenCalledWith('s-1', 'r-1');
    // No stream is open, so the screen reads what is stored.
    await waitFor(() => expect(result.current.activeRun).toBeUndefined());
    expect(result.current.awaiting).toEqual([]);
  });

  it('shows the notice of the stream by its code', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        {
          type: 'data-notice',
          data: { code: 'summarizing', text: 'x' },
          transient: true,
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = render(api);
    await act(() => result.current.send('hi'));
    await waitFor(() => expect(result.current.notice).toBe('summarizing'));
  });

  it('shows the error of a failed run and the stored state', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-1' },
        runChunks('failed'),
        { type: 'error', errorText: 'The model call failed.' },
      ]),
    );
    api.getSession.mockResolvedValue(detail({ items: items(user('hi')) }));
    const { result } = render(api);

    await act(() => result.current.send('hi'));

    await waitFor(() =>
      expect(result.current.error).toBe('The model call failed.'),
    );
    await waitFor(() => expect(api.getSession).toHaveBeenCalled());
    expect(result.current.activeRun).toBeUndefined();
    await waitFor(() => expect(result.current.interrupted).toBe(true));
  });

  it('shows an expired run and sends the message again', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = render(
      api,
      detail({ items: items(user('restart payments')) }),
    );
    expect(result.current.interrupted).toBe(true);
    expect(result.current.canResend).toBe(true);

    await act(() => result.current.sendAgain());

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'restart payments', page },
      expect.anything(),
    );
    expect(result.current.interrupted).toBe(false);
  });
});

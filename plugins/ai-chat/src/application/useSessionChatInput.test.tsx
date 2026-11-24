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
  answer,
  call,
  detail,
  inserted,
  insertedItem,
  items,
  mockApi,
  openStream,
  refusal,
  run,
  streamResponse,
  user,
} from '../testData';
import {
  QUEUE_CHANGED_TEXT,
  QUEUE_FULL_TEXT,
  QUEUED_GONE_TEXT,
  useSessionChat,
} from './useSessionChat';

const page = { path: '/ai-chat/s-1' };

const runChunks = (status: string, runId = 'r-1', endReason?: string) => ({
  type: 'data-run',
  data: { runId, status, ...(endReason && { endReason }) },
  transient: true,
});

const queued = (id: string, text: string, position = 1) => ({
  id,
  position,
  text,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
});

/** A run that goes on, and the stream that follows it. */
function runningWithStream() {
  const api = mockApi();
  const stream = openStream();
  api.follow.mockResolvedValue(stream.response);
  const d = detail({
    run: run('running'),
    items: items(user('start the work')),
  });
  const hook = renderHook(() => useSessionChat({ api, detail: d, page }));
  return { api, stream, ...hook };
}

async function ready(
  stream: ReturnType<typeof openStream>,
  api: ReturnType<typeof mockApi>,
) {
  await waitFor(() => expect(api.follow).toHaveBeenCalled());
  stream.push({ type: 'start', messageId: 'run_r-1' }, runChunks('running'));
}

describe('useSessionChat: messages while a run goes on', () => {
  it('inserts into the running run, shows it as waiting, and moves it into the conversation when the model reads it', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage.mockResolvedValue(insertedItem(2, 'also check search'));
    await ready(stream, api);

    await act(async () => {
      expect(await result.current.send('also check search')).toBe(true);
    });

    expect(api.insertMessage).toHaveBeenCalledWith('s-1', 'r-1', {
      text: 'also check search',
      page,
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual([
      { seq: 2, text: 'also check search' },
    ]);
    expect(JSON.stringify(result.current.messages)).not.toContain(
      'also check search',
    );

    stream.push(
      {
        type: 'data-inserted',
        id: 'inserted-2',
        data: { seq: 2, text: 'also check search' },
      },
      { type: 'start-step' },
    );
    await waitFor(() => expect(result.current.pending).toEqual([]));
    const parts = result.current.messages.flatMap(m => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'data-inserted',
        data: { seq: 2, text: 'also check search' },
      }),
    );
  });

  it('does not show a message as waiting when the stream said it was read before the answer came', async () => {
    const { api, stream, result } = runningWithStream();
    let answerInsert!: (item: object) => void;
    api.insertMessage.mockReturnValue(
      new Promise(resolve => {
        answerInsert = resolve;
      }) as never,
    );
    await ready(stream, api);

    let sending!: Promise<boolean>;
    act(() => {
      sending = result.current.send('quick one');
    });
    stream.push({
      type: 'data-inserted',
      id: 'inserted-2',
      data: { seq: 2, text: 'quick one' },
    });
    await waitFor(() =>
      expect(
        result.current.messages.flatMap(m => m.parts.map(p => p.type)),
      ).toContain('data-inserted'),
    );
    await act(async () => {
      answerInsert(insertedItem(2, 'quick one'));
      await sending;
    });

    expect(result.current.pending).toEqual([]);
  });

  it('queues with Ctrl or Cmd and Enter, and puts the message in the list', async () => {
    const { api, stream, result } = runningWithStream();
    api.queueMessage.mockResolvedValue(queued('q1', 'then deploy'));
    await ready(stream, api);

    await act(async () => {
      expect(await result.current.queueMessage('then deploy')).toBe(true);
    });

    expect(api.queueMessage).toHaveBeenCalledWith('s-1', {
      text: 'then deploy',
      page,
    });
    expect(api.insertMessage).not.toHaveBeenCalled();
    expect(result.current.queue.map(m => m.text)).toEqual(['then deploy']);
  });

  it('only queues while the run waits for a decision', async () => {
    const api = mockApi();
    api.queueMessage.mockResolvedValue(queued('q1', 'later'));
    const { result } = renderHook(() =>
      useSessionChat({
        api,
        page,
        detail: detail({
          run: run('waiting_approval'),
          awaitingDecision: ['c1'],
          items: items(user('go'), call('c1')),
        }),
      }),
    );

    await act(() => result.current.send('later'));

    expect(api.queueMessage).toHaveBeenCalledTimes(1);
    expect(api.insertMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a new message when no run goes on, with Enter and with Ctrl or Cmd and Enter alike', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () =>
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = renderHook(() =>
      useSessionChat({ api, page, detail: detail() }),
    );

    await act(() => result.current.send('one'));
    await act(() => result.current.queueMessage('two'));

    expect(api.sendMessage.mock.calls.map(c => c[1])).toEqual([
      { text: 'one', page },
      { text: 'two', page },
    ]);
    expect(api.insertMessage).not.toHaveBeenCalled();
    expect(api.queueMessage).not.toHaveBeenCalled();
  });

  it('leaves the text with the user when the insert fails for another reason', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage.mockRejectedValue(await refusal(500, 'Error'));
    await ready(stream, api);

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send('lost?');
    });

    expect(sent).toBe(false);
    expect(result.current.error).toBeDefined();
    expect(result.current.pending).toEqual([]);
  });
});

describe('useSessionChat: an insert that gets 409', () => {
  it('queues the message when the run has taken the most inserts (InsertLimitReached)', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage.mockRejectedValue(
      await refusal(409, 'InsertLimitReached'),
    );
    api.getSession.mockResolvedValue(
      detail({ run: run('running'), items: items(user('start the work')) }),
    );
    api.queueMessage.mockResolvedValue(queued('q1', 'the sixth'));
    await ready(stream, api);

    await act(async () => {
      expect(await result.current.send('the sixth')).toBe(true);
    });

    expect(api.queueMessage).toHaveBeenCalledWith('s-1', {
      text: 'the sixth',
      page,
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.current.queue.map(m => m.text)).toEqual(['the sixth']);
  });

  it('queues the message when the run now waits for a decision', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage.mockRejectedValue(await refusal(409, 'RunNotRunning'));
    api.getSession.mockResolvedValue(
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('start the work'), call('c1')),
      }),
    );
    api.queueMessage.mockResolvedValue(queued('q1', 'meanwhile'));
    await ready(stream, api);

    await act(async () => {
      expect(await result.current.send('meanwhile')).toBe(true);
    });

    expect(api.queueMessage).toHaveBeenCalledTimes(1);
    expect(api.insertMessage).toHaveBeenCalledTimes(1);
  });

  it('inserts into the new run when the queue started another one', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage
      .mockRejectedValueOnce(await refusal(409, 'RunNotRunning'))
      .mockResolvedValueOnce(insertedItem(9, 'to the next'));
    api.getSession.mockResolvedValue(
      detail({
        run: run('running', 'r-2'),
        items: items(user('start the work')),
      }),
    );
    await ready(stream, api);

    await act(async () => {
      expect(await result.current.send('to the next')).toBe(true);
    });

    expect(api.insertMessage.mock.calls.map(c => c[1])).toEqual(['r-1', 'r-2']);
    expect(api.queueMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual([{ seq: 9, text: 'to the next' }]);
  });

  it('sends the message as a new one when no run goes on any more', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage.mockRejectedValue(await refusal(409, 'RunNotRunning'));
    api.getSession.mockResolvedValue(
      detail({ items: items(user('start the work'), answer('done', 1)) }),
    );
    api.sendMessage.mockImplementation(async () =>
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    await ready(stream, api);
    // The stream of the ended run closes.
    stream.end();

    await act(async () => {
      expect(await result.current.send('after the end')).toBe(true);
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'after the end', page },
      expect.anything(),
    );
    expect(api.queueMessage).not.toHaveBeenCalled();
  });

  it('keeps the text and says why when the queue refuses it as well', async () => {
    const { api, stream, result } = runningWithStream();
    api.insertMessage.mockRejectedValue(
      await refusal(409, 'InsertLimitReached'),
    );
    api.getSession.mockResolvedValue(
      detail({ run: run('running'), items: items(user('start the work')) }),
    );
    api.queueMessage.mockRejectedValue(await refusal(409, 'QueueFull'));
    await ready(stream, api);

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send('no room');
    });

    expect(sent).toBe(false);
    expect(result.current.error).toBe(QUEUE_FULL_TEXT);
  });

  it('sends the message directly when queueing finds no run (NoActiveRun)', async () => {
    const { api, stream, result } = runningWithStream();
    api.queueMessage.mockRejectedValue(await refusal(409, 'NoActiveRun'));
    api.sendMessage.mockImplementation(async () =>
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    await ready(stream, api);
    stream.end();

    await act(async () => {
      expect(await result.current.queueMessage('too late')).toBe(true);
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'too late', page },
      expect.anything(),
    );
  });
});

describe('useSessionChat: the queue after a run', () => {
  const twoRuns = () => {
    const api = mockApi();
    const first = openStream();
    api.sendMessage.mockResolvedValue(first.response);
    return { api, first };
  };

  it('follows the run that the queue started, with its message, without a reload of the page', async () => {
    const { api, first } = twoRuns();
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const chat = useSessionChat({
        api,
        page,
        detail: detail({
          queue: { items: [queued('q1', 'next')], paused: false },
        }),
      });
      seen.push(chat.queuePaused);
      return chat;
    });
    api.getSession.mockResolvedValue(
      detail({
        run: run('running', 'r-2'),
        items: items(user('first'), answer('first answer', 1), {
          ...user('next'),
          runId: 'r-2',
          delivery: 'queued',
        } as never),
      }),
    );
    api.follow.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        runChunks('running', 'r-2'),
        { type: 'start-step' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'second answer' },
        { type: 'text-end', id: 't' },
        { type: 'finish-step' },
        runChunks('completed', 'r-2'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );

    act(() => {
      result.current.send('first');
    });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    first.push(
      { type: 'start', messageId: 'run_r-1' },
      runChunks('running'),
      {
        type: 'data-queue',
        data: { items: [], paused: false, nextRunId: 'r-2' },
        transient: true,
      },
      runChunks('completed'),
      { type: 'finish', finishReason: 'stop' },
    );
    first.end();

    await waitFor(() => expect(api.follow).toHaveBeenCalled());
    await waitFor(() =>
      expect(JSON.stringify(result.current.messages)).toContain(
        'second answer',
      ),
    );
    const texts = result.current.messages.map(m => m.id);
    expect(texts).toContain('run_r-2');
    expect(result.current.messages.some(m => m.id === 'item_3')).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    // Between the two runs the queue is not shown as paused.
    expect(seen).not.toContain(true);
  });

  it('keeps following when the run it follows names the next one: no gap in which the box sends directly', async () => {
    const api = mockApi();
    const first = openStream();
    api.sendMessage.mockResolvedValue(first.response);
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const chat = useSessionChat({ api, page, detail: detail() });
      seen.push(chat.followingNext);
      return chat;
    });
    const second = openStream();
    api.follow.mockResolvedValueOnce(second.response);
    let releaseThird!: () => void;
    api.getSession.mockImplementation(async () => {
      const id = api.follow.mock.calls.length === 0 ? 'r-2' : 'r-3';
      if (id === 'r-3') {
        await new Promise<void>(resolve => {
          releaseThird = resolve;
        });
      }
      return detail({
        run: run('running', id),
        items: items(user('first'), {
          ...user(id),
          runId: id,
          delivery: 'queued',
        } as never),
      });
    });
    const queueTo = (id: string) => ({
      type: 'data-queue',
      data: { items: [], paused: false, nextRunId: id },
      transient: true,
    });

    act(() => {
      result.current.send('first');
    });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    first.push(
      { type: 'start', messageId: 'run_r-1' },
      runChunks('running'),
      queueTo('r-2'),
      runChunks('completed'),
      { type: 'finish', finishReason: 'stop' },
    );
    first.end();
    await waitFor(() => expect(api.follow).toHaveBeenCalledTimes(1));
    second.push(
      { type: 'start', messageId: 'run_r-2' },
      runChunks('running', 'r-2'),
      queueTo('r-3'),
      runChunks('completed', 'r-2'),
      { type: 'finish', finishReason: 'stop' },
    );
    second.end();

    // The second run has ended; the session is being read for the third.
    await waitFor(() => expect(releaseThird).toBeDefined());
    expect(result.current.followingNext).toBe(true);
    api.follow.mockResolvedValueOnce(
      streamResponse([
        { type: 'start', messageId: 'run_r-3' },
        runChunks('running', 'r-3'),
        runChunks('completed', 'r-3'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    releaseThird();
    await waitFor(() => expect(api.follow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.followingNext).toBe(false));
    // From the first data-queue to the third run's own data-run it never dropped.
    const first1 = seen.indexOf(true);
    const dropped = seen.slice(first1).indexOf(false);
    expect(dropped).toBeGreaterThan(0);
    expect(seen.slice(first1, first1 + dropped).length).toBeGreaterThan(0);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shows the queue as paused, with the reason, when the run did not end normally', async () => {
    const { api, first } = twoRuns();
    api.getSession.mockResolvedValue(
      detail({
        items: items(user('first')),
        queue: { items: [queued('q1', 'next')], paused: true },
      }),
    );
    const { result } = renderHook(() =>
      useSessionChat({ api, page, detail: detail() }),
    );

    act(() => {
      result.current.send('first');
    });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    first.push(
      { type: 'start', messageId: 'run_r-1' },
      runChunks('running'),
      {
        type: 'data-queue',
        data: {
          items: [queued('q1', 'next')],
          paused: true,
          pausedReason: 'run_not_completed',
        },
        transient: true,
      },
      runChunks('failed'),
      { type: 'error', errorText: 'The model call failed.' },
    );
    first.end();

    await waitFor(() => expect(result.current.queuePaused).toBe(true));
    await waitFor(() => expect(api.getSession).toHaveBeenCalled());
    // The reload does not know the reason; the stream did.
    await waitFor(() =>
      expect(result.current.queuePausedReason).toBe('run_not_completed'),
    );
    expect(result.current.queue.map(m => m.text)).toEqual(['next']);
  });

  it('does not show a queue as paused while a run goes on', async () => {
    const api = mockApi();
    api.follow.mockResolvedValue(openStream().response);
    const { result } = renderHook(() =>
      useSessionChat({
        api,
        page,
        detail: detail({
          run: run('running'),
          items: items(user('go')),
          queue: { items: [queued('q1', 'next')], paused: true },
        }),
      }),
    );
    expect(result.current.queuePaused).toBe(false);
  });

  it('shows the queue as paused when a stored session has no run and a queue', () => {
    const { result } = renderHook(() =>
      useSessionChat({
        api: mockApi(),
        page,
        detail: detail({
          items: items(user('go')),
          queue: { items: [queued('q1', 'next')], paused: true },
        }),
      }),
    );
    expect(result.current.queuePaused).toBe(true);
    expect(result.current.queuePausedReason).toBeUndefined();
  });

  it('sends a new message while the queue is paused, as an ordinary message', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () =>
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = renderHook(() =>
      useSessionChat({
        api,
        page,
        detail: detail({
          items: items(user('go')),
          queue: { items: [queued('q1', 'next')], paused: true },
        }),
      }),
    );

    await act(() => result.current.send('new one first'));

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'new one first', page },
      expect.anything(),
    );
    expect(api.queueMessage).not.toHaveBeenCalled();
    expect(api.resumeQueue).not.toHaveBeenCalled();
  });

  it('continues the paused queue: the response is the stream of the new run', async () => {
    const api = mockApi();
    api.resumeQueue.mockResolvedValue(
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        runChunks('running', 'r-2'),
        runChunks('completed', 'r-2'),
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    api.getQueue.mockResolvedValue({ items: [], paused: false });
    const { result } = renderHook(() =>
      useSessionChat({
        api,
        page,
        detail: detail({
          items: items(user('go')),
          queue: { items: [queued('q1', 'next')], paused: true },
        }),
      }),
    );

    await act(() => result.current.continueQueue());

    expect(api.resumeQueue).toHaveBeenCalledWith('s-1', expect.anything());
    expect(api.sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.queue).toEqual([]));
  });
});

describe('useSessionChat: messages the run did not read', () => {
  it('reads the session again when a run ends with messages that were waiting, and shows them as not read', async () => {
    const api = mockApi();
    const stream = openStream();
    api.follow.mockResolvedValue(stream.response);
    api.getSession.mockResolvedValue(
      detail({
        items: items(
          user('start'),
          answer('some answer', 1),
          inserted('late', 'unread'),
        ),
      }),
    );
    const { result } = renderHook(() =>
      useSessionChat({
        api,
        page,
        detail: detail({
          run: run('running'),
          items: items(user('start'), inserted('late', 'pending')),
        }),
      }),
    );
    expect(result.current.pending).toEqual([{ seq: 2, text: 'late' }]);
    await waitFor(() => expect(api.follow).toHaveBeenCalled());

    stream.push({ type: 'start', messageId: 'run_r-1' }, runChunks('running'));
    await waitFor(() => expect(result.current.busy).toBe(true));
    stream.push(runChunks('completed', 'r-1', 'max_steps'), {
      type: 'finish',
      finishReason: 'stop',
    });
    stream.end();

    await waitFor(() => expect(api.getSession).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pending).toEqual([]));
    const unread = result.current.messages
      .flatMap(m => m.parts)
      .filter(p => p.type === 'data-unread');
    expect(unread).toHaveLength(1);
    expect(result.current.interrupted).toBe(false);
  });

  it('sends a message that was not read again as a new message', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () =>
      streamResponse([
        { type: 'start', messageId: 'run_r-2' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const { result } = renderHook(() =>
      useSessionChat({ api, page, detail: detail() }),
    );

    await act(() => result.current.sendTextAgain('late'));

    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'late', page },
      expect.anything(),
    );
  });
});

describe('useSessionChat: changes to the queue', () => {
  const queueOf = (...texts: string[]) => ({
    items: texts.map((text, i) => queued(`q${i + 1}`, text, i + 1)),
    paused: false,
  });
  const render = (api: ReturnType<typeof mockApi>) =>
    renderHook(() =>
      useSessionChat({
        api,
        page,
        detail: detail({
          run: run('waiting_approval'),
          awaitingDecision: ['c1'],
          items: items(user('go'), call('c1')),
          queue: queueOf('a', 'b', 'c'),
        }),
      }),
    );

  it('edits, deletes and moves a message with the routes of the queue', async () => {
    const api = mockApi();
    api.updateQueuedMessage.mockResolvedValue(queued('q2', 'b2', 2));
    api.reorderQueue.mockResolvedValue({
      items: [
        queued('q2', 'b2', 1),
        queued('q1', 'a', 2),
        queued('q3', 'c', 3),
      ],
      paused: false,
    });
    const { result } = render(api);

    await act(async () => {
      expect(await result.current.editQueued('q2', 'b2')).toBe(true);
    });
    expect(api.updateQueuedMessage).toHaveBeenCalledWith('s-1', 'q2', {
      text: 'b2',
    });
    expect(result.current.queue.map(m => m.text)).toEqual(['a', 'b2', 'c']);

    await act(() => result.current.moveQueued('q2', -1));
    expect(api.reorderQueue).toHaveBeenCalledWith('s-1', {
      ids: ['q2', 'q1', 'q3'],
    });
    expect(result.current.queue.map(m => m.id)).toEqual(['q2', 'q1', 'q3']);

    await act(() => result.current.removeQueued('q1'));
    expect(api.deleteQueuedMessage).toHaveBeenCalledWith('s-1', 'q1');
    expect(result.current.queue.map(m => m.id)).toEqual(['q2', 'q3']);
  });

  it('does not ask for a move past the ends of the list', async () => {
    const api = mockApi();
    const { result } = render(api);
    await act(() => result.current.moveQueued('q1', -1));
    await act(() => result.current.moveQueued('q3', 1));
    expect(api.reorderQueue).not.toHaveBeenCalled();
  });

  it('reads the queue again and says so when the message was sent or deleted elsewhere (404)', async () => {
    const api = mockApi();
    api.updateQueuedMessage.mockRejectedValue(
      await refusal(404, 'QueuedMessageNotFound'),
    );
    api.getQueue.mockResolvedValue(queueOf('b', 'c'));
    const { result } = render(api);

    await act(async () => {
      expect(await result.current.editQueued('q1', 'x')).toBe(false);
    });

    expect(result.current.queueNotice).toBe(QUEUED_GONE_TEXT);
    expect(api.getQueue).toHaveBeenCalledWith('s-1');
    expect(result.current.queue.map(m => m.text)).toEqual(['b', 'c']);
  });

  it('reads the queue again and says so when the order is stale (409 QueueChanged)', async () => {
    const api = mockApi();
    api.reorderQueue.mockRejectedValue(await refusal(409, 'QueueChanged'));
    api.getQueue.mockResolvedValue(queueOf('a', 'c'));
    const { result } = render(api);

    await act(() => result.current.moveQueued('q2', 1));

    expect(result.current.queueNotice).toBe(QUEUE_CHANGED_TEXT);
    expect(result.current.queue.map(m => m.text)).toEqual(['a', 'c']);
  });

  it('moves one at a time, from the order the last move made', async () => {
    const api = mockApi();
    let finish!: (q: object) => void;
    api.reorderQueue.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }) as never,
    );
    const { result } = render(api);

    act(() => {
      result.current.moveQueued('q1', 1);
    });
    expect(result.current.queueMoving).toBe(true);
    await act(() => result.current.moveQueued('q2', 1));
    expect(api.reorderQueue).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({
        items: [
          queued('q2', 'b', 1),
          queued('q1', 'a', 2),
          queued('q3', 'c', 3),
        ],
        paused: false,
      });
    });
    await waitFor(() => expect(result.current.queueMoving).toBe(false));
    api.reorderQueue.mockResolvedValueOnce(queueOf('b', 'c', 'a'));
    await act(() => result.current.moveQueued('q1', 1));
    expect(api.reorderQueue).toHaveBeenLastCalledWith('s-1', {
      ids: ['q2', 'q3', 'q1'],
    });
  });

  it('does not keep the reason of a pause when the queue is read again after a focus change', async () => {
    const api = mockApi();
    const stream = openStream();
    api.sendMessage.mockResolvedValue(stream.response);
    api.getSession.mockResolvedValue(
      detail({
        items: items(user('go')),
        queue: { items: [queued('q1', 'a')], paused: true },
      }),
    );
    const { result } = renderHook(() =>
      useSessionChat({ api, page, detail: detail() }),
    );
    act(() => {
      result.current.send('go');
    });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    stream.push({ type: 'start', messageId: 'run_r-1' }, runChunks('running'));
    await waitFor(() => expect(result.current.busy).toBe(true));
    stream.push(
      {
        type: 'data-queue',
        data: {
          items: [queued('q1', 'a')],
          paused: true,
          pausedReason: 'credentials',
        },
        transient: true,
      },
      runChunks('failed'),
      { type: 'error', errorText: 'x' },
    );
    stream.end();
    await waitFor(() =>
      expect(result.current.queuePausedReason).toBe('credentials'),
    );

    api.getQueue.mockResolvedValue({
      items: [queued('q1', 'a')],
      paused: true,
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(result.current.queuePausedReason).toBeUndefined(),
    );
    expect(result.current.queuePaused).toBe(true);
  });

  it('reads the queue again when the window gets the focus back', async () => {
    const api = mockApi();
    api.getQueue.mockResolvedValue(queueOf('x'));
    const { result } = render(api);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() =>
      expect(result.current.queue.map(m => m.text)).toEqual(['x']),
    );
  });
});

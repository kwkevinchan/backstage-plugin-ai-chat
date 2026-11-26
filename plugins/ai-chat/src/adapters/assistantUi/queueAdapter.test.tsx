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
import type { AppendMessage } from '@assistant-ui/react';
import type { ChatSessionDetail } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import {
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
} from '../../testData';
import {
  INSERT_LIMIT_TEXT,
  QUEUED_GONE_TEXT,
  RUN_NOT_RUNNING_TEXT,
  useSessionChat,
} from '../../application/useSessionChat';
import { insertedItemId, useQueueAdapter } from './queueAdapter';

// The contract of the queue adapter: each method of the queue of assistant-ui
// reaches the route of the backend that the design names, through the chat.

const page = { path: '/ai-chat/s-1' };

const queued = (id: string, text: string, position = 1) => ({
  id,
  position,
  text,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
});
const queueOf = (...texts: string[]) => ({
  items: texts.map((text, i) => queued(`q${i + 1}`, text, i + 1)),
  paused: false,
});

const message = (text: string) =>
  ({
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: [],
    createdAt: new Date(),
    parentId: null,
    sourceId: null,
    runConfig: undefined,
    metadata: { custom: {} },
  } as unknown as AppendMessage);

const runningDetail = () =>
  detail({
    run: run('running'),
    items: items(user('start the work'), inserted('look at search', 'pending')),
    queue: queueOf('a', 'b', 'c'),
  });
const waitingDetail = () =>
  detail({
    run: run('waiting_approval'),
    awaitingDecision: ['c1'],
    items: items(user('restart payments'), call('c1')),
    queue: queueOf('a', 'b', 'c'),
  });
const idleDetail = () => detail({ items: items(user('done')) });

function setup(d: ChatSessionDetail) {
  const api = mockApi();
  // A running run is followed through a stream that stays open.
  api.follow.mockResolvedValue(openStream().response);
  api.sendMessage.mockImplementation(async () =>
    streamResponse([
      { type: 'start', messageId: 'run_r-2' },
      { type: 'finish', finishReason: 'stop' },
    ]),
  );
  const hook = renderHook(() => {
    const chat = useSessionChat({ api, detail: d, page });
    const queue = useQueueAdapter({
      queued: chat.queue,
      inserted: chat.pending,
      send: chat.send,
      queueMessage: chat.queueMessage,
      editQueued: chat.editQueued,
      removeQueued: chat.removeQueued,
      moveQueued: chat.moveQueued,
      insertQueued: chat.insertQueued,
    });
    return { chat, queue };
  });
  return { api, ...hook };
}

describe('queue adapter: the two lanes', () => {
  it('has the queue of the backend in items, and the inserted messages that were not read in steerItems', () => {
    const { result } = setup(runningDetail());
    const { queue } = result.current;
    expect(queue.items.map(item => [item.id, item.parts])).toEqual([
      ['q1', [{ type: 'text', text: 'a' }]],
      ['q2', [{ type: 'text', text: 'b' }]],
      ['q3', [{ type: 'text', text: 'c' }]],
    ]);
    expect(queue.steerItems.map(item => item.id)).toEqual([insertedItemId(2)]);
    expect(queue.steerItems[0].parts).toEqual([
      { type: 'text', text: 'look at search' },
    ]);
    expect(queue.laneOf('q2')).toBe('queue');
    expect(queue.laneOf(insertedItemId(2))).toBe('steer');
    expect(queue.laneOf('nothing')).toBeUndefined();
  });

  it('counts the images of an item', () => {
    const d = waitingDetail();
    d.queue.items[0].attachments = [
      { id: 'i1', mediaType: 'image/png', name: 'a.png', size: 1 },
      { id: 'i2', mediaType: 'image/png', name: 'b.png', size: 1 },
    ];
    const { result } = setup(d);
    expect(result.current.queue.imageCountOf('q1')).toBe(2);
    expect(result.current.queue.imageCountOf('q2')).toBe(0);
  });
});

describe('queue adapter: steer and enqueue in each state of the run', () => {
  it('running: steer inserts into the run, enqueue queues', async () => {
    const { api, result } = setup(runningDetail());
    api.insertMessage.mockResolvedValue(insertedItem(4, 'one'));
    api.queueMessage.mockResolvedValue(queued('q4', 'two', 4));

    await act(async () => {
      expect(await result.current.queue.steer(message('one'))).toBe(true);
    });
    expect(api.insertMessage).toHaveBeenCalledWith(
      's-1',
      'r-1',
      expect.objectContaining({ text: 'one' }),
    );
    await act(async () => {
      expect(await result.current.queue.enqueue(message('two'))).toBe(true);
    });
    expect(api.queueMessage).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ text: 'two' }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('waiting_approval: steer and enqueue both queue', async () => {
    const { api, result } = setup(waitingDetail());
    api.queueMessage.mockResolvedValue(queued('q4', 'x', 4));

    await act(() => result.current.queue.steer(message('one')));
    await act(() => result.current.queue.enqueue(message('two')));
    expect(api.queueMessage.mock.calls.map(c => c[1].text)).toEqual([
      'one',
      'two',
    ]);
    expect(api.insertMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('no run: steer and enqueue both send the message as a new run', async () => {
    const { api, result } = setup(idleDetail());

    await act(() => result.current.queue.steer(message('one')));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    await act(() => result.current.queue.enqueue(message('two')));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.sendMessage.mock.calls.map(c => c[1].text)).toEqual([
      'one',
      'two',
    ]);
    expect(api.queueMessage).not.toHaveBeenCalled();
    expect(api.insertMessage).not.toHaveBeenCalled();
  });

  it('sends nothing for a message without text', async () => {
    const { api, result } = setup(runningDetail());
    await act(async () => {
      expect(await result.current.queue.steer(message('  '))).toBe(false);
    });
    expect(api.insertMessage).not.toHaveBeenCalled();
  });
});

describe('queue adapter: changes to the queue', () => {
  it('edit and remove use PATCH and DELETE of the queued message', async () => {
    const { api, result } = setup(waitingDetail());
    api.updateQueuedMessage.mockResolvedValue(queued('q2', 'b2', 2));

    await act(async () => {
      expect(await result.current.queue.edit('q2', message('b2'))).toBe(true);
    });
    expect(api.updateQueuedMessage).toHaveBeenCalledWith('s-1', 'q2', {
      text: 'b2',
    });
    await act(() => result.current.queue.remove('q1'));
    expect(api.deleteQueuedMessage).toHaveBeenCalledWith('s-1', 'q1');
    expect(result.current.queue.items.map(item => item.id)).toEqual([
      'q2',
      'q3',
    ]);
  });

  it('move within the queue puts the queue in the new order (PUT queue/order)', async () => {
    const { api, result } = setup(waitingDetail());
    api.reorderQueue.mockImplementation(async (_id, { ids }) => ({
      items: ids.map((id, i) =>
        queued(id, { q1: 'a', q2: 'b', q3: 'c' }[id]!, i + 1),
      ),
      paused: false,
    }));

    await act(() =>
      result.current.queue.move('q3', { lane: 'queue', insertBefore: 'q1' }),
    );
    expect(api.reorderQueue).toHaveBeenLastCalledWith('s-1', {
      ids: ['q3', 'q1', 'q2'],
    });
    await act(() =>
      result.current.queue.move('q3', { lane: 'queue', insertAfter: 'q2' }),
    );
    expect(api.reorderQueue).toHaveBeenLastCalledWith('s-1', {
      ids: ['q1', 'q2', 'q3'],
    });
    // A move to where the item is already asks nothing.
    await act(() =>
      result.current.queue.move('q3', { lane: 'queue', insertAfter: 'q2' }),
    );
    expect(api.reorderQueue).toHaveBeenCalledTimes(2);
  });

  it('leaves an inserted message alone: no edit, no remove, no move', async () => {
    const { api, result } = setup(runningDetail());
    const id = insertedItemId(2);
    await act(async () => {
      expect(await result.current.queue.edit(id, message('x'))).toBe(false);
    });
    await act(() => result.current.queue.remove(id));
    await act(() =>
      result.current.queue.move(id, { lane: 'steer', insertAfter: null }),
    );
    expect(api.updateQueuedMessage).not.toHaveBeenCalled();
    expect(api.deleteQueuedMessage).not.toHaveBeenCalled();
    expect(api.insertQueuedMessage).not.toHaveBeenCalled();
    expect(api.reorderQueue).not.toHaveBeenCalled();
  });
});

describe('queue adapter: move to the steer lane ("send now")', () => {
  const steer = { lane: 'steer', insertAfter: null } as const;

  it('reads the queue, then moves the message into the running run (POST queue/:queuedId/insert)', async () => {
    const { api, result } = setup(runningDetail());
    // Another tab changed it: the screen shows the stored text, and the
    // backend inserts what is stored.
    api.getQueue.mockResolvedValue({
      items: [queued('q1', 'a'), queued('q2', 'b changed', 2)],
      paused: false,
    });
    api.insertQueuedMessage.mockResolvedValue(insertedItem(7, 'b changed'));

    await act(() => result.current.queue.move('q2', steer));

    expect(api.getQueue).toHaveBeenCalledWith('s-1');
    expect(api.insertQueuedMessage).toHaveBeenCalledWith('s-1', 'q2', {
      runId: 'r-1',
    });
    expect(api.getQueue.mock.invocationCallOrder[0]).toBeLessThan(
      api.insertQueuedMessage.mock.invocationCallOrder[0],
    );
    const { queue } = result.current;
    expect(queue.items.map(item => item.id)).toEqual(['q1']);
    expect(queue.steerItems.map(item => item.id)).toEqual([
      insertedItemId(2),
      insertedItemId(7),
    ]);
    expect(queue.steerItems[1].parts).toEqual([
      { type: 'text', text: 'b changed' },
    ]);
  });

  it('does not insert a message that the stored queue no longer has', async () => {
    const { api, result } = setup(runningDetail());
    api.getQueue.mockResolvedValue({
      items: [queued('q1', 'a')],
      paused: false,
    });

    await act(() => result.current.queue.move('q2', steer));

    expect(api.insertQueuedMessage).not.toHaveBeenCalled();
    expect(result.current.chat.queueNotice).toBe(QUEUED_GONE_TEXT);
    expect(result.current.queue.items.map(item => item.id)).toEqual(['q1']);
  });

  it('404: the message was removed or sent; it says so and reads the queue again', async () => {
    const { api, result } = setup(runningDetail());
    api.getQueue
      .mockResolvedValueOnce(queueOf('a', 'b', 'c'))
      .mockResolvedValueOnce(queueOf('a', 'c'));
    api.insertQueuedMessage.mockRejectedValue(
      await refusal(404, 'QueuedMessageNotFound'),
    );

    await act(() => result.current.queue.move('q2', steer));

    expect(result.current.chat.queueNotice).toBe(QUEUED_GONE_TEXT);
    expect(api.getQueue).toHaveBeenCalledTimes(2);
    expect(result.current.queue.items.map(item => item.parts[0])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'c' },
    ]);
  });

  it('409 RunNotRunning: the run ended or waits; it says so and reads the session again', async () => {
    const { api, result } = setup(runningDetail());
    api.getQueue.mockResolvedValue(queueOf('a', 'b', 'c'));
    api.insertQueuedMessage.mockRejectedValue(
      await refusal(409, 'RunNotRunning'),
    );
    // The queue sent the first message as the next run.
    api.getSession.mockResolvedValue(
      detail({
        run: run('running', 'r-2'),
        items: items(user('start the work'), user('b')),
        queue: queueOf('a', 'c'),
      }),
    );

    await act(() => result.current.queue.move('q2', steer));

    expect(result.current.chat.queueNotice).toBe(RUN_NOT_RUNNING_TEXT);
    expect(api.getSession).toHaveBeenCalledWith('s-1');
    await waitFor(() => expect(result.current.chat.activeRun?.id).toBe('r-2'));
    expect(result.current.queue.items).toHaveLength(2);
  });

  it('409 InsertLimitReached: the message stays in the queue, and it says why', async () => {
    const { api, result } = setup(runningDetail());
    api.getQueue.mockResolvedValue(queueOf('a', 'b', 'c'));
    api.insertQueuedMessage.mockRejectedValue(
      await refusal(409, 'InsertLimitReached'),
    );

    await act(() => result.current.queue.move('q2', steer));

    expect(result.current.chat.queueNotice).toBe(INSERT_LIMIT_TEXT);
    expect(result.current.queue.items.map(item => item.id)).toEqual([
      'q1',
      'q2',
      'q3',
    ]);
  });

  it('takes one send now at a time', async () => {
    const { api, result } = setup(runningDetail());
    api.getQueue.mockResolvedValue(queueOf('a', 'b', 'c'));
    api.insertQueuedMessage.mockResolvedValue(insertedItem(7, 'b'));

    await act(async () => {
      const first = result.current.queue.move('q2', steer);
      const second = result.current.queue.move('q2', steer);
      await Promise.all([first, second]);
    });
    expect(api.insertQueuedMessage).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while the run waits for a decision', async () => {
    const { api, result } = setup(waitingDetail());
    await act(() => result.current.queue.move('q2', steer));
    expect(api.getQueue).not.toHaveBeenCalled();
    expect(api.insertQueuedMessage).not.toHaveBeenCalled();
  });
});

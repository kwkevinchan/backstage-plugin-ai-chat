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

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInTestApp } from '@backstage/test-utils';
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
import { PAUSED_TEXT, QUEUE_FIRST_NOTE } from './QueuePanel';
import { UNREAD_TEXT } from './MessageList';
import { SessionView } from './SessionView';

const queued = (id: string, text: string, position = 1) => ({
  id,
  position,
  text,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
});

const running = () =>
  detail({ run: run('running'), items: items(user('start the work')) });
const waiting = () =>
  detail({
    run: run('waiting_approval'),
    awaitingDecision: ['c1'],
    items: items(user('restart payments'), call('c1')),
  });
const paused = () =>
  detail({
    items: items(user('first'), answer('stopped', 1)),
    queue: {
      items: [queued('q1', 'send this next'), queued('q2', 'and then this', 2)],
      paused: true,
    },
  });

async function open(
  api: ReturnType<typeof mockApi>,
  d: ReturnType<typeof detail>,
) {
  // A run that goes on is followed through a stream that stays open.
  if (d.run?.status === 'running') {
    api.follow.mockResolvedValue(openStream().response);
  }
  await renderInTestApp(<SessionView api={api} detail={d} toolsets={[]} />, {
    routeEntries: ['/ai-chat/s-1'],
  });
  return screen.getByLabelText('Message');
}

const answerStream = () =>
  streamResponse([
    { type: 'start', messageId: 'run_r-2' },
    { type: 'finish', finishReason: 'stop' },
  ]);

describe('Composer while a run goes on', () => {
  it('is usable while the run is running: Enter inserts, Ctrl+Enter and the Queue button queue', async () => {
    const api = mockApi();
    api.insertMessage.mockResolvedValue(insertedItem(2, 'one'));
    api.queueMessage.mockResolvedValue(queued('q1', 'two'));
    const box = await open(api, running());
    expect(box).toBeEnabled();

    await userEvent.type(box, 'one{Enter}');
    await waitFor(() => expect(api.insertMessage).toHaveBeenCalledTimes(1));
    expect(api.insertMessage.mock.calls[0].slice(0, 3)).toEqual([
      's-1',
      'r-1',
      expect.objectContaining({ text: 'one' }),
    ]);
    expect(api.queueMessage).not.toHaveBeenCalled();

    await userEvent.type(box, 'two{Control>}{Enter}{/Control}');
    await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(1));
    expect(api.queueMessage.mock.calls[0][1]).toMatchObject({ text: 'two' });

    await userEvent.type(box, 'three');
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(2));

    await userEvent.type(box, 'four{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(3));
    expect(api.insertMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('shows an inserted message above the box until the model reads it', async () => {
    const api = mockApi();
    api.insertMessage.mockResolvedValue(insertedItem(2, 'also look at search'));
    const box = await open(api, running());

    await userEvent.type(box, 'also look at search{Enter}');

    const area = await screen.findByRole('list', {
      name: 'Waiting to be read',
    });
    expect(area).toHaveTextContent('also look at search');
    expect(area).toHaveTextContent(
      'The agent has not read this yet. It will at the next step.',
    );
    expect(box).toHaveValue('');
  });

  it('keeps the text in the box when the message could not be taken', async () => {
    const api = mockApi();
    api.insertMessage.mockRejectedValue(await refusal(500, 'Error'));
    const box = await open(api, running());

    await userEvent.type(box, 'do not lose me{Enter}');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(box).toHaveValue('do not lose me');
  });

  it('only queues while the run waits for a decision, and says why', async () => {
    const api = mockApi();
    api.queueMessage.mockResolvedValue(queued('q1', 'after'));
    const box = await open(api, waiting());
    expect(screen.getByText(/only be queued/)).toBeInTheDocument();
    // One button, named for what it does.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Queue' })).toHaveLength(1);

    await userEvent.type(box, 'one{Enter}');
    await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(1));
    await userEvent.type(box, 'two{Control>}{Enter}{/Control}');
    await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(2));
    expect(api.insertMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends with Enter and with Ctrl+Enter alike when no run goes on, and has no Queue button', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () => answerStream());
    const box = await open(
      api,
      detail({ items: items(user('a'), answer('b', 1)) }),
    );
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();

    await userEvent.type(box, 'one{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    await userEvent.type(box, 'two{Control>}{Enter}{/Control}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.queueMessage).not.toHaveBeenCalled();
    expect(api.insertMessage).not.toHaveBeenCalled();
  });

  it('sends a new message while the queue is paused, says the queue follows, and does not continue it', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () => answerStream());
    const box = await open(api, paused());
    expect(
      screen.getByText(
        'After you send, the queue continues when this run ends.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();

    await userEvent.type(box, 'me first{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    await userEvent.type(box, 'me too{Control>}{Enter}{/Control}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.resumeQueue).not.toHaveBeenCalled();
    expect(api.queueMessage).not.toHaveBeenCalled();
  });
});

describe('the queue list', () => {
  it('shows the paused queue with the order note, the reason and Continue', async () => {
    const api = mockApi();
    api.resumeQueue.mockResolvedValue(answerStream());
    await open(api, paused());

    const queue = screen.getByRole('region', { name: 'Queue' });
    expect(within(queue).getByText('Queued (2)')).toBeInTheDocument();
    expect(within(queue).getByText(QUEUE_FIRST_NOTE)).toBeInTheDocument();
    expect(within(queue).getByText(PAUSED_TEXT.unknown)).toBeInTheDocument();
    expect(within(queue).getByText('send this next')).toBeInTheDocument();

    await userEvent.click(
      within(queue).getByRole('button', { name: 'Continue' }),
    );
    await waitFor(() => expect(api.resumeQueue).toHaveBeenCalledTimes(1));
  });

  it('does not say paused, or Continue, while a run goes on', async () => {
    const api = mockApi();
    await open(
      api,
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('go'), call('c1')),
        queue: { items: [queued('q1', 'later')], paused: false },
      }),
    );
    const queue = screen.getByRole('region', { name: 'Queue' });
    expect(within(queue).getByText('Queued (1)')).toBeInTheDocument();
    expect(within(queue).queryByText(QUEUE_FIRST_NOTE)).toBeNull();
    expect(
      within(queue).queryByRole('button', { name: 'Continue' }),
    ).toBeNull();
  });

  it('edits a message in place, deletes one and moves one', async () => {
    const api = mockApi();
    api.updateQueuedMessage.mockResolvedValue(queued('q1', 'changed'));
    api.reorderQueue.mockResolvedValue({
      items: [queued('q2', 'and then this'), queued('q1', 'changed', 2)],
      paused: true,
    });
    await open(api, paused());
    const queue = screen.getByRole('region', { name: 'Queue' });
    const rows = () => within(queue).getAllByRole('listitem');

    expect(
      within(rows()[0]).getByRole('button', { name: 'Move up' }),
    ).toBeDisabled();
    expect(
      within(rows()[1]).getByRole('button', { name: 'Move down' }),
    ).toBeDisabled();

    await userEvent.click(
      within(rows()[0]).getByRole('button', { name: 'Edit' }),
    );
    const field = within(queue).getByLabelText('Queued message');
    await userEvent.clear(field);
    await userEvent.type(field, 'changed');
    await userEvent.click(within(queue).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateQueuedMessage).toHaveBeenCalledWith('s-1', 'q1', {
        text: 'changed',
      }),
    );
    expect(await within(queue).findByText('changed')).toBeInTheDocument();

    await userEvent.click(
      within(rows()[0]).getByRole('button', { name: 'Move down' }),
    );
    await waitFor(() =>
      expect(api.reorderQueue).toHaveBeenCalledWith('s-1', {
        ids: ['q2', 'q1'],
      }),
    );
    await waitFor(() => expect(rows()[0]).toHaveTextContent('and then this'));

    await userEvent.click(
      within(rows()[0]).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() =>
      expect(api.deleteQueuedMessage).toHaveBeenCalledWith('s-1', 'q2'),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('explains it and shows the new list when the message was sent elsewhere', async () => {
    const api = mockApi();
    api.updateQueuedMessage.mockRejectedValue(
      await refusal(404, 'QueuedMessageNotFound'),
    );
    api.getQueue.mockResolvedValue({
      items: [queued('q2', 'and then this')],
      paused: true,
    });
    await open(api, paused());
    const queue = screen.getByRole('region', { name: 'Queue' });

    await userEvent.click(
      within(queue).getAllByRole('button', { name: 'Edit' })[0],
    );
    const field = within(queue).getByLabelText('Queued message');
    await userEvent.type(field, ' more');
    await userEvent.click(within(queue).getByRole('button', { name: 'Save' }));

    expect(
      await within(queue).findByText(
        'That message was sent or removed already.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(queue).queryByText('send this next')).toBeNull(),
    );
    expect(within(queue).getByText('and then this')).toBeInTheDocument();
  });

  it('says why the queue is paused when the stream gave a reason', async () => {
    const api = mockApi();
    const sent = openStream();
    api.sendMessage.mockResolvedValue(sent.response);
    const box = await open(
      api,
      detail({ items: items(user('a'), answer('b', 1)) }),
    );
    await userEvent.type(box, 'go{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    api.getSession.mockResolvedValue(detail({ items: items(user('go')) }));

    sent.push(
      { type: 'start', messageId: 'run_r-1' },
      {
        type: 'data-run',
        data: { runId: 'r-1', status: 'running' },
        transient: true,
      },
    );
    await screen.findByRole('button', { name: 'Stop' });
    sent.push(
      {
        type: 'data-queue',
        data: {
          items: [queued('q1', 'waiting')],
          paused: true,
          pausedReason: 'credentials',
        },
        transient: true,
      },
      {
        type: 'data-run',
        data: { runId: 'r-1', status: 'completed' },
        transient: true,
      },
      { type: 'finish', finishReason: 'stop' },
    );
    sent.end();

    expect(
      await screen.findByText(PAUSED_TEXT.credentials),
    ).toBeInTheDocument();
  });
});

describe('a message that the run did not read', () => {
  const unreadButtons = () =>
    screen.queryAllByRole('button', { name: /again/i });

  it('has a button of its own when the run gave an answer, and no button for the run', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () => answerStream());
    await open(
      api,
      detail({
        items: items(
          user('first'),
          answer('the answer', 1),
          inserted('too late', 'unread'),
        ),
      }),
    );

    expect(screen.getByText(UNREAD_TEXT)).toBeInTheDocument();
    expect(unreadButtons().map(b => b.textContent)).toEqual([
      'Send this message again',
    ]);

    await userEvent.click(unreadButtons()[0]);
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({ text: 'too late' }),
        expect.anything(),
      ),
    );
  });

  it('has one button for the run, which sends its first message, when the run gave no answer', async () => {
    const api = mockApi();
    api.sendMessage.mockImplementation(async () => answerStream());
    await open(
      api,
      detail({
        items: items(
          user('restart payments'),
          call('c1'),
          inserted('use staging', 'unread'),
          inserted('and be quick', 'unread'),
        ),
      }),
    );

    expect(screen.getAllByText(UNREAD_TEXT)).toHaveLength(2);
    expect(unreadButtons().map(b => b.textContent)).toEqual([
      'Send the message again',
    ]);

    await userEvent.click(unreadButtons()[0]);
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({ text: 'restart payments' }),
        expect.anything(),
      ),
    );
  });

  it('has no button of its own while a run goes on', async () => {
    const api = mockApi();
    await open(
      api,
      detail({
        run: run('running', 'r-2'),
        items: items(
          user('first'),
          answer('the answer', 1),
          inserted('too late', 'unread'),
        ),
      }),
    );

    expect(screen.getByText(UNREAD_TEXT)).toBeInTheDocument();
    expect(unreadButtons()).toHaveLength(0);
  });
});

describe('the thread', () => {
  it('shows a table of the answer, and no image of it', async () => {
    const api = mockApi();
    await open(
      api,
      detail({
        items: items(
          user('table'),
          answer(
            '| Service | Restarts |\n| --- | --- |\n| payments | 1 |\n\n![x](https://example.test/x.png)',
          ),
        ),
      }),
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('cell', { name: 'payments' })).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  it('decides a call from its card: the decision goes to the backend with the call id', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(answerStream());
    await open(api, waiting());
    const card = await screen.findByRole('region', {
      name: 'Approval: Restart service',
    });
    await userEvent.click(within(card).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(1));
    expect(api.decide.mock.calls[0].slice(0, 3)).toEqual([
      's-1',
      'c1',
      expect.objectContaining({ approved: true }),
    ]);
  });

  it('does not stop the run on Escape in the box', async () => {
    const api = mockApi();
    const box = await open(api, waiting());
    await userEvent.type(box, 'draft{Escape}');
    expect(api.cancelRun).not.toHaveBeenCalled();
    expect(box).toHaveValue('draft');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('stops a run that waits for a decision', async () => {
    const api = mockApi();
    await open(api, waiting());
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(api.cancelRun).toHaveBeenCalledWith('s-1', 'r-1'),
    );
  });

  it('shows no empty message while the answer has not started', async () => {
    const api = mockApi();
    await open(api, running());
    expect(
      document.querySelectorAll('[class*="chat-message-assistant"]'),
    ).toHaveLength(0);
    expect(screen.getByText('start the work')).toBeInTheDocument();
  });

  it('has a disabled Send while the box is empty, and sends with it when no run goes on', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answerStream());
    const box = await open(api, detail());
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.type(box, 'hello');
    expect(send).toBeEnabled();
    await userEvent.click(send);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(box).toHaveValue('');
  });
});

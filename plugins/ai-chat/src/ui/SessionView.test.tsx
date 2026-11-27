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

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
import {
  PAUSED_TEXT,
  QUEUE_FIRST_NOTE,
  WAITING_TEXT,
  queueFullText,
} from './ComposerQueue';
import {
  INSERT_LIMIT_TEXT,
  RUN_NOT_RUNNING_TEXT,
} from '../application/useSessionChat';
import {
  WRONG_TYPE_TEXT,
  tooLargeText,
  tooManyText,
} from '../adapters/assistantUi/attachmentAdapter';
import { IMAGE_GONE_TEXT } from './Attachments';
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

/** Object URLs in jsdom, which has none: each is `blob:<n>`, and revokes are recorded. */
function stubObjectUrls() {
  let next = 0;
  const create = jest.fn(() => {
    next += 1;
    return `blob:${next}`;
  });
  const revoke = jest.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
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

describe('the queue while a run is running', () => {
  const runningWithQueue = (...texts: string[]) =>
    detail({
      run: run('running'),
      items: items(
        user('start the work'),
        inserted('look at search', 'pending'),
      ),
      queue: {
        items: texts.map((text, i) => queued(`q${i + 1}`, text, i + 1)),
        paused: false,
      },
    });
  const queueRegion = () => screen.getByRole('region', { name: 'Queue' });
  const row = (text: string) =>
    within(queueRegion())
      .getAllByRole('listitem')
      .find(item => item.textContent?.includes(text))!;

  it('shows an inserted message without Delete or Send now, and a queued one with all its actions', async () => {
    const api = mockApi();
    await open(api, runningWithQueue('later'));

    const waitingList = screen.getByRole('list', {
      name: 'Waiting to be read',
    });
    expect(waitingList).toHaveTextContent('look at search');
    expect(waitingList).toHaveTextContent(WAITING_TEXT);
    expect(within(waitingList).queryAllByRole('button')).toHaveLength(0);

    const actions = within(row('later'))
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label'));
    expect(actions).toEqual([
      'Move up',
      'Move down',
      'Edit',
      'Delete',
      'Send now',
    ]);
    expect(
      within(row('later')).getByRole('button', { name: 'Send now' }),
    ).toBeEnabled();
  });

  it('Send now moves the queued message into the run: it leaves the queue and waits to be read', async () => {
    const api = mockApi();
    api.getQueue.mockResolvedValue({
      items: [queued('q1', 'first'), queued('q2', 'second', 2)],
      paused: false,
    });
    api.insertQueuedMessage.mockResolvedValue(insertedItem(5, 'second'));
    await open(api, runningWithQueue('first', 'second'));

    await userEvent.click(
      within(row('second')).getByRole('button', { name: 'Send now' }),
    );

    await waitFor(() =>
      expect(api.insertQueuedMessage).toHaveBeenCalledWith('s-1', 'q2', {
        runId: 'r-1',
      }),
    );
    await waitFor(() =>
      expect(within(queueRegion()).getAllByRole('listitem')).toHaveLength(1),
    );
    expect(queueRegion()).not.toHaveTextContent('second');
    expect(
      screen.getByRole('list', { name: 'Waiting to be read' }),
    ).toHaveTextContent('second');
  });

  it('sends now once: the button is off while the request is on its way', async () => {
    const api = mockApi();
    api.getQueue.mockResolvedValue({
      items: [queued('q1', 'later')],
      paused: false,
    });
    let respond!: (item: ReturnType<typeof insertedItem>) => void;
    api.insertQueuedMessage.mockReturnValue(
      new Promise(resolve => {
        respond = resolve;
      }),
    );
    await open(api, runningWithQueue('later'));
    const sendNow = () =>
      within(row('later')).getByRole('button', { name: 'Send now' });

    await userEvent.click(sendNow());
    await waitFor(() => expect(api.insertQueuedMessage).toHaveBeenCalled());
    expect(sendNow()).toBeDisabled();
    await userEvent.click(sendNow());
    expect(api.insertQueuedMessage).toHaveBeenCalledTimes(1);

    respond(insertedItem(5, 'later'));
    await waitFor(() =>
      expect(
        screen.getByRole('list', { name: 'Waiting to be read' }),
      ).toHaveTextContent('later'),
    );
  });

  it('has Send now off while the run waits for a decision', async () => {
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
    expect(
      within(row('later')).getByRole('button', { name: 'Send now' }),
    ).toBeDisabled();
  });

  it('says why Send now did not move the message (409)', async () => {
    const api = mockApi();
    api.getQueue.mockResolvedValue({
      items: [queued('q1', 'later')],
      paused: false,
    });
    api.insertQueuedMessage.mockRejectedValueOnce(
      await refusal(409, 'InsertLimitReached'),
    );
    await open(api, runningWithQueue('later'));

    await userEvent.click(
      within(row('later')).getByRole('button', { name: 'Send now' }),
    );
    expect(
      await within(queueRegion()).findByText(INSERT_LIMIT_TEXT),
    ).toBeInTheDocument();
    expect(row('later')).toBeDefined();

    api.insertQueuedMessage.mockRejectedValueOnce(
      await refusal(409, 'RunNotRunning'),
    );
    api.getSession.mockResolvedValue(
      detail({
        items: items(user('start the work'), answer('done', 2)),
        queue: { items: [queued('q1', 'later')], paused: true },
      }),
    );
    await userEvent.click(
      within(row('later')).getByRole('button', { name: 'Send now' }),
    );
    expect(
      await within(queueRegion()).findByText(RUN_NOT_RUNNING_TEXT),
    ).toBeInTheDocument();
    expect(api.getSession).toHaveBeenCalledWith('s-1');
  });

  it('says when the queue is full, and shows the images of a queued message', async () => {
    const api = mockApi();
    api.readAttachment.mockResolvedValue(new Blob(['png']));
    stubObjectUrls();
    const d = runningWithQueue('a', 'b', 'c', 'd', 'e');
    d.queue.items[1].attachments = [
      { id: 'i1', mediaType: 'image/png', name: 'a.png', size: 1 },
      { id: 'i2', mediaType: 'image/png', name: 'b.png', size: 1 },
    ];
    await open(api, d);
    expect(
      await within(queueRegion()).findByText(queueFullText(5)),
    ).toBeInTheDocument();
    expect(
      await within(row('b')).findByRole('img', { name: 'a.png' }),
    ).toBeInTheDocument();
    expect(within(row('b')).getByRole('img', { name: 'b.png' })).toBeVisible();
    expect(api.readAttachment).toHaveBeenCalledWith('s-1', 'i1');
    expect(within(row('a')).queryByRole('img')).toBeNull();
  });

  it('has no full note below the limit', async () => {
    const api = mockApi();
    await open(api, runningWithQueue('a', 'b'));
    await waitFor(() => expect(api.getInputConfig).toHaveBeenCalled());
    expect(within(queueRegion()).queryByText(/queue is full/)).toBeNull();
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

describe('images', () => {
  const image = (id = 'att-1', name = 'dot.png') => ({
    id,
    mediaType: 'image/png',
    name,
    size: 4,
  });
  const png = (name = 'dot.png', size = 4) =>
    new File([new Uint8Array(size)], name, { type: 'image/png' });

  function imagesOn(api: ReturnType<typeof mockApi>, maxPerMessage = 4) {
    api.getInputConfig.mockResolvedValue({
      images: {
        enabled: true,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        maxPerMessage,
        maxBytes: 1024,
        maxBytesPerInput: 20 * 1024 * 1024,
        maxPendingPerSession: 12,
      },
      insertMaxPerRun: 5,
      queueMaxMessages: 5,
      references: { maxPerMessage: 5, maxTextLength: 4000 },
    });
    api.uploadAttachment.mockImplementation(async (_s, _file, name) =>
      image(`att-${name}`, name),
    );
    stubObjectUrls();
  }

  const withImages = <T extends object>(item: T, attachments: object[]) =>
    ({ ...item, attachments } as T);

  const idle = () => detail({ items: items(user('done'), answer('ok')) });

  async function attachWithButton(files: File[]) {
    await userEvent.click(
      await screen.findByRole('button', { name: 'Attach' }),
    );
    const input =
      document.body.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    await userEvent.upload(input, files, { applyAccept: false });
  }
  const paste = (box: HTMLElement, files: File[]) =>
    fireEvent.paste(box, { clipboardData: { files, getData: () => '' } });
  const drop = (files: File[]) => {
    const zone = screen
      .getByLabelText('Message')
      .closest('[class*="chat-composer-box"]')!;
    const dataTransfer = { files, types: ['Files'] };
    fireEvent.dragEnter(zone, { dataTransfer });
    fireEvent.drop(zone, { dataTransfer });
  };
  const draft = (name: string) =>
    screen.getByRole('button', { name: `Remove ${name}` }).parentElement!;

  it('has no Attach when the model reads no images, and takes no pasted or dropped image', async () => {
    const api = mockApi();
    stubObjectUrls();
    const box = await open(api, idle());
    await waitFor(() => expect(api.getInputConfig).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
    paste(box, [png()]);
    drop([png('b.png')]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('attaches with the button, a paste and a drop, uploads each to the session, and sends their ids', async () => {
    const api = mockApi();
    imagesOn(api);
    api.sendMessage.mockResolvedValue(answerStream());
    const box = await open(api, idle());
    await attachWithButton([png('a.png')]);
    paste(box, [png('b.png')]);
    drop([png('c.png')]);
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(3));
    expect(api.uploadAttachment.mock.calls.map(c => [c[0], c[2]])).toEqual([
      ['s-1', 'a.png'],
      ['s-1', 'b.png'],
      ['s-1', 'c.png'],
    ]);
    for (const name of ['a.png', 'b.png', 'c.png']) {
      expect(within(draft(name)).getByRole('img', { name })).toBeVisible();
    }
    await userEvent.type(box, 'look{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        text: 'look',
        attachmentIds: ['att-a.png', 'att-b.png', 'att-c.png'],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull(),
    );
  });

  it('does not upload a file of another type, one too large or one too many, and says why; the next attach replaces the reasons', async () => {
    const api = mockApi();
    imagesOn(api, 1);
    const box = await open(api, idle());
    await screen.findByRole('button', { name: 'Attach' });
    paste(box, [
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      png('big.png', 2048),
      png('a.png'),
      png('b.png'),
    ]);
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
    expect(screen.getAllByRole('alert').map(a => a.textContent)).toEqual([
      WRONG_TYPE_TEXT,
      tooLargeText(1024),
      tooManyText(1),
    ]);
    expect(api.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(api.uploadAttachment.mock.calls[0][2]).toBe('a.png');

    // The next attach replaces the reasons; a remove makes room.
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    paste(box, [png('c.png')]);
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });

  it('sends no image that was removed', async () => {
    const api = mockApi();
    imagesOn(api);
    api.sendMessage.mockResolvedValue(answerStream());
    const box = await open(api, idle());
    await screen.findByRole('button', { name: 'Attach' });
    paste(box, [png('a.png'), png('b.png')]);
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    await waitFor(() =>
      expect(api.deleteAttachment).toHaveBeenCalledWith('s-1', 'att-a.png'),
    );
    await userEvent.type(box, 'one{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1].attachmentIds).toEqual([
      'att-b.png',
    ]);
  });

  it('keeps the text and says why when the upload is refused (413)', async () => {
    const api = mockApi();
    imagesOn(api);
    api.uploadAttachment.mockRejectedValue(
      Object.assign(new Error('Request failed with 413'), {
        cause: new Error('An image may be at most 1024 bytes'),
      }),
    );
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const box = await open(api, idle());
    await userEvent.type(box, 'keep this text');
    await screen.findByRole('button', { name: 'Attach' });
    paste(box, [png()]);
    await screen.findByRole('button', { name: 'Remove dot.png' });
    expect(
      await within(draft('dot.png')).findByRole('alert'),
    ).toHaveTextContent('An image may be at most 1024 bytes');
    expect(box).toHaveValue('keep this text');

    // Send keeps the message while the failed image is in the box.
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(box).toHaveValue('keep this text'));
    expect(within(draft('dot.png')).getByRole('alert')).toBeVisible();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while an image uploads, and sends it with the message when the upload ends', async () => {
    const api = mockApi();
    imagesOn(api);
    api.sendMessage.mockResolvedValue(answerStream());
    let finish: () => void = () => {};
    api.uploadAttachment.mockImplementation(
      (_s, file, name) =>
        new Promise(resolve => {
          finish = () =>
            resolve({
              id: `att-${name}`,
              name,
              mediaType: (file as File).type,
              size: (file as File).size,
            });
        }),
    );
    const box = await open(api, idle());
    await screen.findByRole('button', { name: 'Attach' });
    paste(box, [png()]);
    expect(await screen.findByText('Uploading...')).toBeVisible();
    await userEvent.type(box, 'wait for it{Enter}');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(box).toHaveValue('wait for it');
    expect(api.sendMessage).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        text: 'wait for it',
        attachmentIds: ['att-dot.png'],
      }),
    );
  });

  it('sends a message that is only an image', async () => {
    const api = mockApi();
    imagesOn(api);
    api.sendMessage.mockResolvedValue(answerStream());
    const box = await open(api, idle());
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await screen.findByRole('button', { name: 'Attach' });
    paste(box, [png()]);
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({ text: '', attachmentIds: ['att-dot.png'] }),
    );
  });

  it('inserts a message with an image into the running run', async () => {
    const api = mockApi();
    imagesOn(api);
    api.insertMessage.mockResolvedValue(insertedItem(2, ''));
    const box = await open(api, running());
    await screen.findByRole('button', { name: 'Attach' });
    paste(box, [png()]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove dot.png' }),
      ).toBeVisible(),
    );
    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(api.insertMessage).toHaveBeenCalledTimes(1));
    expect(api.insertMessage.mock.calls[0][2]).toEqual(
      expect.objectContaining({ text: '', attachmentIds: ['att-dot.png'] }),
    );
  });

  it('shows the images of a message, loaded with the request of the user, and says when one is gone', async () => {
    const api = mockApi();
    stubObjectUrls();
    api.readAttachment.mockImplementation(async (_s, id) => {
      if (id === 'gone') throw new Error('404');
      return new Blob(['png']);
    });
    const d = detail({
      items: items(
        withImages(user('two pictures'), [
          image('att-1', 'a.png'),
          image('gone', 'b.png'),
        ]),
        answer('I see them'),
      ),
    });
    await open(api, d);
    const shown = await screen.findByRole('img', { name: 'a.png' });
    expect(shown).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(
      await screen.findByText(`b.png. ${IMAGE_GONE_TEXT}`),
    ).toBeInTheDocument();
    expect(api.readAttachment).toHaveBeenCalledWith('s-1', 'att-1');
    expect(api.readAttachment).toHaveBeenCalledWith('s-1', 'gone');
  });

  it('shows the image of an inserted message where the model read it', async () => {
    const api = mockApi();
    stubObjectUrls();
    api.readAttachment.mockResolvedValue(new Blob(['png']));
    const d = detail({
      items: items(
        user('start'),
        withImages(inserted('', 'read'), [image('att-9', 'added.png')]),
        answer('done', 2),
      ),
    });
    await open(api, d);
    expect(
      await screen.findByRole('img', { name: 'added.png' }),
    ).toBeInTheDocument();
  });

  it('sends a message that the run did not read again with its images', async () => {
    const api = mockApi();
    stubObjectUrls();
    api.readAttachment.mockResolvedValue(new Blob(['png']));
    api.sendMessage.mockResolvedValue(answerStream());
    const d = detail({
      items: items(
        user('start'),
        answer('first answer', 1),
        withImages(inserted('look', 'unread'), [image('att-5', 'late.png')]),
      ),
    });
    await open(api, d);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Send this message again' }),
    );
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({ text: 'look', attachmentIds: ['att-5'] }),
    );
  });

  it('renders agent replies and plan cards for forked sessions whose items have no runId', async () => {
    const api = mockApi();
    const t = '2026-11-26T00:00:00.000Z';
    const forked = detail({
      items: [
        {
          sessionId: 's-1',
          seq: 1,
          createdAt: t,
          kind: 'user_message',
          text: 'list services',
        },
        {
          sessionId: 's-1',
          seq: 2,
          createdAt: t,
          kind: 'agent_message',
          text: 'Here is the result of the action: payments is running.',
        },
        {
          sessionId: 's-1',
          seq: 3,
          createdAt: t,
          kind: 'plan_update',
          plan: {
            items: [{ text: 'Inspect payments service', status: 'completed' }],
          },
        },
      ],
    });
    await open(api, forked);

    expect(await screen.findByText('list services')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Here is the result of the action: payments is running.',
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Inspect payments service'),
    ).toBeInTheDocument();
  });
});

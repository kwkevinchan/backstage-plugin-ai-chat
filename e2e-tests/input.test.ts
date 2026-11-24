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

import { expect, Page, test } from '@playwright/test';
import { signIn, snapshot, watch } from './support';

/**
 * Messages while a run goes on, with the scripted model server: a message
 * inserted into the run, the queue (list, order, a run that waits for a
 * decision, a run that fails, two tabs), and a message that the run did not
 * read. The scripted model has a reply that takes seconds to arrive
 * (`hold <seconds>`), which is the time to add a message to the run.
 */

const box = (page: Page) => page.getByLabel('Message', { exact: true });
const queue = (page: Page) => page.getByRole('region', { name: 'Queue' });
const rows = (page: Page) => queue(page).getByRole('listitem');
const waitingToBeRead = (page: Page) =>
  page.getByRole('list', { name: 'Waiting to be read' });
const timeline = (page: Page) => page.locator('[aria-live="polite"]');

async function enter(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press('Enter');
}

async function queueIt(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press('Control+Enter');
}

/** The position of each text in the conversation, to check the order. */
async function order(page: Page, ...texts: string[]) {
  const all = await timeline(page).innerText();
  const at = texts.map(text => all.indexOf(text));
  expect(at, `all of ${texts.join(' | ')} are shown`).not.toContain(-1);
  expect(at, `the order of ${texts.join(' | ')}`).toEqual(
    [...at].sort((a, b) => a - b),
  );
}

test('Enter inserts into the run: waiting above the box, then in the conversation, and the next answer uses it', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await enter(page, 'hold 4');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.getByText(/\bheld3\b/)).toBeVisible();
  // The box takes a message while the run goes on.
  await expect(box(page)).toBeEnabled();
  await enter(page, 'also use the staging cluster');
  await expect(box(page)).toHaveValue('');
  const waiting = waitingToBeRead(page);
  await expect(waiting).toContainText('also use the staging cluster');
  await expect(waiting).toContainText(
    'The agent has not read this yet. It will at the next step.',
  );
  // Not in the conversation yet.
  await expect(timeline(page)).not.toContainText('use the staging cluster');
  await snapshot(page, '20-inserted-waiting');

  // The step ends, the model reads it: it leaves the box area and is in the
  // conversation, and the next answer uses it.
  await expect(waiting).toBeHidden();
  await expect(
    page.getByText('Got your addition: use the staging cluster'),
  ).toBeVisible();
  await expect(
    timeline(page).getByText('also use the staging cluster', { exact: true }),
  ).toHaveCount(1);
  await order(
    page,
    'held40',
    'also use the staging cluster',
    'Got your addition: use the staging cluster',
  );
  await expect(page.getByText('[saw: hold 4]')).toBeVisible();
  await shot('20b-inserted-read');
});

test('a run that waits for a decision only queues, and the queued message is sent by itself after the decision', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await enter(page, 'restart billing');
  const card = page.getByRole('region', {
    name: 'Approval: Restart a service',
  });
  await expect(card.getByRole('button', { name: 'Allow' })).toBeVisible();
  await expect(page.getByText(/can only be queued/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);

  await enter(page, 'also after the restart');
  await expect(queue(page)).toContainText('also after the restart');
  await expect(queue(page)).toContainText('Queued (1)');
  await expect(waitingToBeRead(page)).toHaveCount(0);
  await snapshot(page, '21-queued-while-waiting');

  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(
    page.getByText('Here is the result of the action'),
  ).toBeVisible();
  // The queue sends the message when the run ends: no reload of the page.
  await expect(
    page.getByText('Got your addition: after the restart'),
  ).toBeVisible();
  await expect(queue(page)).toBeHidden();
  await order(
    page,
    'Here is the result of the action',
    'also after the restart',
    'Got your addition: after the restart',
  );
  await shot('21b-queue-sent-itself');
});

test('the queue list: edit, delete and move, and it is still there after a reload', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await enter(page, 'hold 12');
  await expect(page.getByText(/\bheld2\b/)).toBeVisible();
  await queueIt(page, 'also alpha');
  await queueIt(page, 'also beta');
  await queueIt(page, 'also gamma');
  await expect(queue(page)).toContainText('Queued (3)');

  const row = (text: string) => rows(page).filter({ hasText: text });
  await row('also beta').getByRole('button', { name: 'Edit' }).click();
  await queue(page).getByLabel('Queued message').fill('also beta2');
  await queue(page).getByRole('button', { name: 'Save' }).click();
  await expect(row('also beta2')).toBeVisible();

  await row('also gamma').getByRole('button', { name: 'Move up' }).click();
  await row('also alpha').getByRole('button', { name: 'Delete' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText('also gamma');
  await expect(rows(page).nth(1)).toContainText('also beta2');
  await snapshot(page, '22-queue-list');

  await page.reload();
  await expect(queue(page)).toContainText('Queued (2)');
  await expect(rows(page).nth(0)).toContainText('also gamma');
  await expect(rows(page).nth(1)).toContainText('also beta2');

  // The run ends and the queue sends its messages, in the new order.
  await expect(page.getByText('Got your addition: beta2')).toBeVisible();
  await expect(page.getByText('Got your addition: gamma')).toBeVisible();
  await order(page, 'Got your addition: gamma', 'Got your addition: beta2');
  await expect(page.getByText('Got your addition: alpha')).toHaveCount(0);
  await expect(queue(page)).toBeHidden();
  await shot('22b-queue-drained');
});

const PAUSED = 'Queue paused. The last run did not end normally.';

test('a run that fails pauses the queue: nothing is sent until Continue', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await enter(page, 'fail');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await queueIt(page, 'also while failing');
  await expect(queue(page)).toContainText('Queued (1)');
  // No "paused" while the run goes on.
  await expect(queue(page)).not.toContainText('Queue paused');

  await expect(queue(page)).toContainText(PAUSED);
  await expect(queue(page)).toContainText(
    'New messages go first, the queue follows',
  );
  await expect(
    page.getByText('After you send, the queue continues when this run ends.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Queue', exact: true }),
  ).toHaveCount(0);
  await snapshot(page, '23-queue-paused');
  await page.waitForTimeout(1500);
  await expect(page.getByText('Got your addition')).toHaveCount(0);

  await queue(page).getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByText('Got your addition: while failing'),
  ).toBeVisible();
  await expect(queue(page)).toBeHidden();
  await shot('23b-queue-continued');
});

test('a message sent while the queue is paused goes first, and the queue follows when it ends', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await enter(page, 'fail');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await queueIt(page, 'also second');
  await expect(queue(page)).toContainText(PAUSED);

  await enter(page, 'also first');
  await expect(page.getByText('Got your addition: first')).toBeVisible();
  // That run ended normally: the queue goes on by itself.
  await expect(page.getByText('Got your addition: second')).toBeVisible();
  await order(page, 'Got your addition: first', 'Got your addition: second');
  await expect(queue(page)).toBeHidden();
  await shot('23c-new-message-first');
});

test('Stop with a message that was not read: it says so, and one button sends the first message again', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await enter(page, 'hold 10');
  await expect(page.getByText(/\bheld2\b/)).toBeVisible();
  await enter(page, 'also never read');
  await expect(waitingToBeRead(page)).toContainText('also never read');
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(
    page.getByText('The agent did not read this message.'),
  ).toBeVisible();
  await expect(waitingToBeRead(page)).toHaveCount(0);
  await expect(
    timeline(page).getByText('also never read', { exact: true }),
  ).toBeVisible();
  // The run gave no answer: one button for the run, none on the message.
  const again = page.getByRole('button', { name: /again/i });
  await expect(again).toHaveCount(1);
  await expect(again).toHaveText('Send the message again');
  await snapshot(page, '24-not-read');

  await again.click();
  // The model sees the first message twice (the stopped run, and this one)
  // and never the message that it did not read.
  await expect(page.getByText('[saw: hold 10 | hold 10]')).toBeVisible({
    timeout: 60_000,
  });
  await shot('24b-sent-again');
});

test('two tabs: one deletes a queued message, the other edits it and is told', async ({
  page,
  context,
}) => {
  const shot = watch(page, [404]);
  await signIn(page);
  await enter(page, 'hold 12');
  await expect(page.getByText(/\bheld2\b/)).toBeVisible();
  await queueIt(page, 'also one');
  await queueIt(page, 'also two');
  await expect(queue(page)).toContainText('Queued (2)');

  const other = await context.newPage();
  watch(other, [404]);
  await other.goto(page.url());
  await expect(queue(other)).toContainText('Queued (2)');

  // The first tab deletes "one"; the second still shows it.
  await rows(page)
    .filter({ hasText: 'also one' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(other)).toHaveCount(2);

  await rows(other)
    .filter({ hasText: 'also one' })
    .getByRole('button', { name: 'Edit' })
    .click();
  await queue(other).getByLabel('Queued message').fill('also one, changed');
  await queue(other).getByRole('button', { name: 'Save' }).click();

  await expect(
    queue(other).getByText('That message was sent or removed already.'),
  ).toBeVisible();
  await expect(rows(other)).toHaveCount(1);
  await expect(rows(other).first()).toContainText('also two');
  await snapshot(other, '25-two-tabs');

  await page.getByRole('button', { name: 'Stop' }).click();
  await other.close();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await shot('25b-two-tabs-first-tab');
});

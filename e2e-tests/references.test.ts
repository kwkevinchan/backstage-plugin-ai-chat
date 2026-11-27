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
import { signIn, watch } from './support';

/**
 * What a message carries (references, the page), with the scripted model
 * server: references from the catalog picker and from a registered source,
 * the page tag left out, text selected on a page and sent with "Ask AI", and
 * the button that opens the chat with a reference and a prompt. The
 * scripted model repeats the references it was given (`refs ...`).
 */

type Body = {
  text?: string;
  page?: { path: string; entityRef?: string };
  references?: Array<Record<string, unknown>>;
};

/** The bodies of the requests that start a run, in the order they were sent. */
function collectRuns(page: Page): Body[] {
  const bodies: Body[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/runs')) {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

const entityPage = '/catalog/default/component/example-payments';

/** The side panel of the chat, once it is open. */
function panelOf(page: Page) {
  return page.getByRole('complementary', { name: 'AI chat' });
}

/** The list of what the next message carries, in the chat page or in the panel. */
function boxOf(scope: Page | ReturnType<typeof panelOf>) {
  return scope.getByRole('list', { name: 'Sent with the message' });
}

async function say(scope: Page | ReturnType<typeof panelOf>, text: string) {
  const input = scope.getByLabel('Message', { exact: true });
  await input.fill(text);
  await input.press('Enter');
}

test('references from the catalog and from a source: tags before sending, on the message, and in what the model reads', async ({
  page,
}) => {
  const shot = watch(page);
  const runs = collectRuns(page);
  await signIn(page);
  const box = boxOf(page);
  await expect(box).toBeVisible();

  // A catalog entity, found by searching.
  await page.getByRole('button', { name: 'Add reference' }).click();
  await page.getByRole('menuitem', { name: 'Catalog entity' }).click();
  const picker = page.getByRole('dialog', { name: 'Catalog entity' });
  await picker
    .getByRole('searchbox', { name: 'Search the catalog' })
    .fill('payments');
  await picker.getByRole('button', { name: /example-payments/ }).click();
  await expect(box.getByText('example-payments')).toBeVisible();

  // A snippet from the source that the app registers.
  await page.getByRole('button', { name: 'Add reference' }).click();
  await page.getByRole('menuitem', { name: 'Example snippets' }).click();
  const source = page.getByRole('dialog', { name: 'Example snippets' });
  await source
    .getByRole('heading', { name: 'Restart policy' })
    .or(source.getByText('Restart policy', { exact: true }))
    .first()
    .waitFor();
  await source.getByRole('button', { name: 'Add' }).first().click();
  await expect(box.getByText('Restart policy')).toBeVisible();

  await say(page, 'refs what do you see');
  const sent = page.getByRole('list', { name: 'References of the message' });
  await expect(sent.getByText('example-payments')).toBeVisible();
  await expect(sent.getByText('Restart policy')).toBeVisible();
  // The box is empty after the send, except for the page.
  await expect(box.getByText('example-payments')).toHaveCount(0);

  const timeline = page.locator('[aria-live="polite"]');
  await expect(timeline).toContainText(
    'Reference 1: the entity "component:default/example-payments"',
  );
  await expect(timeline).toContainText('"name": "example-payments"');
  await expect(timeline).toContainText(
    'Reference 2: a text titled "Restart policy" from "/catalog"',
  );
  await expect(timeline).toContainText('Restart the pods one at a time.');
  await shot('references-sent');

  expect(runs).toHaveLength(1);
  expect(runs[0].references).toEqual([
    { kind: 'entity', entityRef: 'component:default/example-payments' },
    expect.objectContaining({
      kind: 'text',
      title: 'Restart policy',
      url: '/catalog',
    }),
  ]);
});

test('the page tag left out: the next message has no page, and adding it back sends the page again', async ({
  page,
}) => {
  watch(page);
  const runs = collectRuns(page);
  await signIn(page);

  await page
    .getByRole('button', { name: 'Leave out the current page' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Add the current page' }),
  ).toBeVisible();
  await say(page, 'where am i');
  await expect(page.getByText('I do not know where you are.')).toBeVisible();
  expect(runs).toHaveLength(1);
  expect(runs[0].page).toBeUndefined();

  await page.getByRole('button', { name: 'Add the current page' }).click();
  await expect(
    page.getByRole('button', { name: 'Leave out the current page' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await say(page, 'where am i');
  await expect(
    page.getByText(/The user is on the page "\/ai-chat\/[\w-]+"\./),
  ).toBeVisible();
  expect(runs).toHaveLength(2);
  expect(runs[1].page?.path).toMatch(/^\/ai-chat\/[\w-]+$/);
});

test('text selected on a page: "Ask AI" opens the chat with the text as a reference, and the model reads it', async ({
  page,
}) => {
  watch(page);
  const runs = collectRuns(page);
  await signIn(page);
  await page.goto(entityPage);
  const paragraph = page.getByText(/^Restart the pods one at a time/);
  await expect(paragraph).toBeVisible();

  // No selection, no button.
  await expect(
    page.getByRole('button', { name: 'Ask AI', exact: true }),
  ).toHaveCount(0);
  await paragraph.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();

  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  const box = boxOf(panel);
  await expect(box.getByText(/Restart the pods one at a time/)).toBeVisible();
  // Nothing is sent by itself.
  expect(runs).toHaveLength(0);

  await say(panel, 'refs explain this');
  const timeline = panel.locator('[aria-live="polite"]');
  await expect(timeline).toContainText(`from "${entityPage}":`);
  await expect(timeline).toContainText('Restart the pods one at a time.');
  expect(runs).toHaveLength(1);
  expect(runs[0].references).toEqual([
    expect.objectContaining({
      kind: 'text',
      url: entityPage,
      text: expect.stringMatching(/^Restart the pods one at a time/),
    }),
  ]);
  expect(typeof runs[0].references?.[0].title).toBe('string');
});

test('"Ask AI about this service" opens the chat with the entity and the prompt, and sends nothing until the user does', async ({
  page,
}) => {
  watch(page);
  const runs = collectRuns(page);
  await signIn(page);
  await page.goto(entityPage);
  await page.getByRole('button', { name: 'Ask AI about this service' }).click();

  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(boxOf(panel).getByText('example-payments')).toBeVisible();
  const input = panel.getByLabel('Message', { exact: true });
  await expect(input).toHaveValue('Is this service ready for a restart?');
  // Wait a moment: a send by itself would show here.
  await page.waitForTimeout(1500);
  expect(runs).toHaveLength(0);

  await input.press('Enter');
  await expect(
    panel
      .getByText('I can **list**')
      .or(panel.getByText(/I can list the services/)),
  ).toBeVisible();
  expect(runs).toHaveLength(1);
  expect(runs[0].references).toEqual([
    { kind: 'entity', entityRef: 'component:default/example-payments' },
  ]);
});

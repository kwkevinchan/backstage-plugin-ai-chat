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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, Page, test } from '@playwright/test';

/**
 * The chat with the scripted model server and the development actions:
 * a read-only call that runs at once, an action that waits for approval and
 * runs after Allow, an action that is rejected, the proof (a new list) that
 * only the allowed action changed anything, and an action of the catalog.
 * Then what the page does with a stored session: reload, its own URL, two
 * approvals decided one at a time, a reload while a call runs, a stop, the
 * page context and the switch of a toolset.
 *
 * The tests run in this order against one backend with its state in memory:
 * the first one counts the restarts of \`payments\` and \`search\`.
 */
const app = process.env.SMOKE_APP ?? 'app';
const shotSuffix = process.env.SMOKE_SHOT_SUFFIX ?? '';
const shotDir = process.env.SMOKE_SHOT_DIR ?? join('e2e-test-results', app);

function isIgnoredConsoleError(text: string): boolean {
  if (
    /Failed to load resource: the server responded with a status of (401|400)/.test(
      text,
    )
  ) {
    return true;
  }
  // React warnings of the Backstage packages (for example findDOMNode in
  // Material UI 4) are not ours; a warning that names this plugin is.
  const fromOurCode = /plugins\/ai-chat|backstage-plugin-ai-chat/.test(text);
  return text.startsWith('Warning: ') && !fromOurCode;
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !isIgnoredConsoleError(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', error => errors.push(`pageerror: ${error}`));
  page.on('response', response => {
    if (response.status() >= 500) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  mkdirSync(shotDir, { recursive: true });
  return async (name: string) => {
    // Wait until the answer is complete.
    await expect(page.locator('[aria-live="polite"]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await page.screenshot({
      path: join(shotDir, `${name}${shotSuffix}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    expect(errors, `errors before ${name}`).toEqual([]);
  };
}

async function signIn(page: Page) {
  await page.goto('/');
  const enter = page.getByRole('button', { name: 'Enter' });
  await expect(enter).toBeVisible();
  await enter.click();
  // The sign-in is done when the sign-in page is gone.
  await expect(enter).toBeHidden();
  await page.goto('/ai-chat');
  await expect(page.getByLabel('Message')).toBeVisible();
}

async function say(page: Page, text: string) {
  // A message cannot start while the run of the last one goes on.
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await page.getByLabel('Message').fill(text);
  await page.getByLabel('Message').press('Enter');
}

test('read-only call, approval, rejection', async ({ page }) => {
  const shot = watch(page);
  await signIn(page);
  await shot('01-empty-chat');

  // A read-only action runs without asking.
  await say(page, 'list services');
  const row = page.locator('details', { hasText: 'List services' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Done')).toBeVisible();
  await expect(
    page.getByText('Here is the result of the action'),
  ).toBeVisible();
  // Input and output are folded until the row is opened.
  await expect(row.getByText('"restarts": 0')).toBeHidden();
  await shot('02-read-only-call');
  await row.locator('summary').click();
  await expect(row.getByText('"restarts": 0').first()).toBeVisible();
  await expect(
    row.getByRole('link', { name: /example-payments/ }),
  ).toBeVisible();
  await shot('02b-read-only-call-expanded');

  // An action that changes something waits for the user.
  await say(page, 'restart payments');
  const card = page.getByRole('region', {
    name: 'Approval: Restart service',
  });
  await expect(card).toBeVisible();
  await expect(card.getByText('Waiting for approval')).toBeVisible();
  await expect(card.getByText('"name": "payments"')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow' })).toBeVisible();
  await shot('03-approval-card');

  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(card.getByText('Allowed.')).toBeVisible();
  await expect(card.getByText('Done')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await card.locator('summary').click();
  await expect(
    card.getByRole('link', {
      name: /localhost:\d+\/catalog\/default\/component\/example-payments/,
    }),
  ).toBeVisible();
  await shot('04-after-allow');

  // A rejected action does not run, and the model is told.
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'restart search');
  const second = page.getByRole('region', {
    name: 'Approval: Restart service',
  });
  await expect(second.getByRole('button', { name: 'Reject' })).toBeVisible();
  await second.getByRole('button', { name: 'Reject' }).click();
  await expect(second.getByText('Rejected.')).toBeVisible();
  await expect(page.getByText('I did not run that action')).toBeVisible();
  await shot('05-rejected');

  // Only the allowed restart happened.
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'list services');
  await expect(
    page.getByText(/"name":"payments","status":"running","restarts":1/),
  ).toBeVisible();
  await expect(
    page.getByText(/"name":"search","status":"running","restarts":0/),
  ).toBeVisible();
  await shot('06-only-the-allowed-restart');

  // An action of another plugin (the catalog) is read like the others.
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'catalog entities');
  const catalogRow = page.locator('details', {
    hasText: 'Query catalog entities',
  });
  await expect(catalogRow.getByText('Done')).toBeVisible();
  await shot('07-catalog-action');
});

const card = (page: Page, title = 'Restart service') =>
  page.getByRole('region', { name: `Approval: ${title}` });

test('reload keeps the stored result, and the session has its own URL', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await say(page, 'list services');
  const row = page.locator('details', { hasText: 'List services' });
  await expect(row.getByText('Done')).toBeVisible();
  await expect(page).toHaveURL(/\/ai-chat\/[\w-]+$/);
  const url = page.url();

  // After a reload the stored items are there once: no second message, no
  // second call.
  await page.reload();
  await expect(
    page.locator('details', { hasText: 'List services' }),
  ).toHaveCount(1);
  await expect(page.getByText('Here is the result of the action')).toHaveCount(
    1,
  );
  await expect(page.getByText('list services', { exact: true })).toHaveCount(1);
  await shot('08-after-reload');

  // The URL opens that session in a new page, and the list names it.
  await page.goto('/');
  await page.goto(url);
  await expect(
    page.locator('details', { hasText: 'List services' }),
  ).toHaveCount(1);
});

test('two approvals: one decision survives a reload and is not sent again', async ({
  page,
}) => {
  const shot = watch(page);
  const decisions: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/decision')) {
      decisions.push(request.url().split('/tool-calls/')[1]);
    }
  });
  await signIn(page);

  await say(page, 'restart both');
  const cards = card(page);
  await expect(cards).toHaveCount(2);
  await expect(cards.getByRole('button', { name: 'Allow' })).toHaveCount(2);

  // Deciding one call stores the decision; the other still waits.
  await cards.first().getByRole('button', { name: 'Allow' }).click();
  await expect(cards.first().getByText('Allowed.')).toBeVisible();
  await expect(cards.getByRole('button', { name: 'Allow' })).toHaveCount(1);
  expect(decisions).toHaveLength(1);

  await page.reload();
  await expect(cards).toHaveCount(2);
  await expect(
    cards.first().getByText('Allowed', { exact: true }),
  ).toBeVisible();
  await expect(cards.getByRole('button', { name: 'Allow' })).toHaveCount(1);
  await shot('09-one-decided-after-reload');

  // The second decision lets the run go on; the first is not sent again.
  await cards.last().getByRole('button', { name: 'Allow' }).click();
  await expect(cards.first().getByText('Done')).toBeVisible();
  await expect(cards.last().getByText('Done')).toBeVisible();
  await expect(
    page.getByText('Here is the result of the action'),
  ).toBeVisible();
  expect(decisions).toHaveLength(2);
  expect(new Set(decisions).size).toBe(2);
  await shot('10-both-decided');

  // Each service restarted once.
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'list services');
  await expect(
    page.getByText(/"name":"search","status":"running","restarts":1/),
  ).toBeVisible();
  await expect(
    page.getByText(/"name":"billing","status":"running","restarts":1/),
  ).toBeVisible();
});

test('reload while an allowed call runs: the page follows the run to the result', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await say(page, 'slow restart payments');
  const slow = card(page, 'Restart service slowly');
  await expect(slow).toBeVisible();
  await slow.getByRole('button', { name: 'Allow' }).click();
  await expect(slow.getByText('Allowed.')).toBeVisible();

  // The action takes a few seconds: the run goes on while the page reloads.
  await page.reload();
  await expect(
    card(page, 'Restart service slowly').getByText('Done'),
  ).toBeVisible();
  await expect(
    page.getByText('Here is the result of the action'),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await shot('11-reload-while-running');

  // The call ran once (the first test restarted payments once already).
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'list services');
  await expect(
    page.getByText(/"name":"payments","status":"running","restarts":2/),
  ).toBeVisible();
});

test('the answer arrives word by word', async ({ page }) => {
  await signIn(page);

  await say(page, 'story');
  const answer = page.locator('[aria-live="polite"]');
  const seen = new Set<number>();
  await expect
    .poll(
      async () => {
        const text = (await answer.textContent()) ?? '';
        const words = text.match(/word\d+/g)?.length ?? 0;
        seen.add(words);
        return words;
      },
      { intervals: [50], timeout: 30_000 },
    )
    .toBe(60);
  // Not all at once: some states between nothing and the whole text.
  expect([...seen].filter(n => n > 0 && n < 60).length).toBeGreaterThan(2);
});

test('Stop ends a run that streams and a run that waits for a decision', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await say(page, 'story');
  await expect(page.getByText(/word3\b/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(
    page.getByText('The last run stopped before it gave an answer.'),
  ).toBeVisible();
  await expect(page.getByText('word60')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await shot('12-stopped-while-streaming');

  // The same session takes a new message after the stop.
  await say(page, 'restart payments');
  await expect(card(page).getByRole('button', { name: 'Allow' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(
    page
      .locator('details', { hasText: 'Restart service' })
      .getByText('Did not run'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await shot('13-stopped-while-waiting');
});

test('opened for an entity: every message carries the entity', async ({
  page,
}) => {
  await signIn(page);
  const bodies: Array<{ page?: { path: string; entityRef?: string } }> = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/runs')) {
      bodies.push(request.postDataJSON());
    }
  });

  await page.goto('/ai-chat?entityRef=component:default/example-payments');
  await say(page, 'list services');
  await expect(
    page.locator('details', { hasText: 'List services' }).getByText('Done'),
  ).toBeVisible();
  await say(page, 'list services');
  await expect(page.getByText('Here is the result of the action')).toHaveCount(
    2,
  );

  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body.page?.entityRef).toBe('component:default/example-payments');
    expect(body.page?.path).toMatch(/^\/ai-chat\/[\w-]+$/);
  }
});

test('switching off a toolset takes its tools away from the session', async ({
  page,
}) => {
  await signIn(page);

  await say(page, 'list services');
  await expect(
    page.locator('details', { hasText: 'List services' }).getByText('Done'),
  ).toBeVisible();

  await page.getByText(/^Toolsets \(/).click();
  const toolset = page
    .locator('label', { has: page.getByRole('checkbox') })
    .first();
  const updated = page.waitForResponse(
    response =>
      response.request().method() === 'PATCH' && response.status() === 200,
  );
  await toolset.getByRole('checkbox').uncheck();
  await updated;

  await say(page, 'list services');
  await expect(
    page.getByText('The tool list-services is not available.'),
  ).toBeVisible();

  await page.reload();
  await page.getByText(/^Toolsets \(/).click();
  await expect(
    page
      .locator('label', { has: page.getByRole('checkbox') })
      .first()
      .getByRole('checkbox'),
  ).not.toBeChecked();
});

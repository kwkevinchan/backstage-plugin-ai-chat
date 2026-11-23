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
 */
const app = process.env.SMOKE_APP ?? 'app';
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
      path: join(shotDir, `${name}.png`),
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
  await row.locator('summary').click();
  await expect(row.getByText('"restarts": 0').first()).toBeVisible();
  await shot('02-read-only-call');

  // An action that changes something waits for the user.
  await say(page, 'restart payments');
  const card = page.getByRole('region', {
    name: 'Approval: Restart a service',
  });
  await expect(card).toBeVisible();
  await expect(card.getByText('Waiting for approval')).toBeVisible();
  await expect(card.getByText('"name": "payments"')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow' })).toBeVisible();
  await shot('03-approval-card');

  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(
    card.getByText(/Allowed by user:default\/guest at /),
  ).toBeVisible();
  await expect(card.getByText('Done')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await card.locator('summary').click();
  await expect(
    card.getByRole('link', {
      name: /localhost:3000\/catalog\/default\/component\/example-payments/,
    }),
  ).toBeVisible();
  await shot('04-after-allow');

  // A rejected action does not run, and the model is told.
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'restart search');
  const second = page.getByRole('region', {
    name: 'Approval: Restart a service',
  });
  await expect(second.getByRole('button', { name: 'Reject' })).toBeVisible();
  await second.getByRole('button', { name: 'Reject' }).click();
  await expect(
    second.getByText(/Rejected by user:default\/guest at /),
  ).toBeVisible();
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
    hasText: 'Query Catalog Entities',
  });
  await expect(catalogRow.getByText('Done')).toBeVisible();
  await shot('07-catalog-action');
});

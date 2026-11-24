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

/** A 1×1 PNG. The backend checks the header, so the bytes have to be an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const box = (page: Page) => page.getByLabel('Message', { exact: true });

async function attach(page: Page, name = 'dot.png') {
  await expect(page.getByRole('button', { name: 'Attach' })).toBeVisible();
  const uploaded = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      response.url().includes('/attachments'),
  );
  await page.locator('input[aria-label="Choose images"]').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: PNG,
  });
  expect((await uploaded).ok()).toBe(true);
  await expect(page.getByRole('img', { name })).toBeVisible();
  await expect(page.getByText('Uploading...')).toHaveCount(0);
}

test('sends the first message of a new conversation with an image, and the thumbnail stays after a reload', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);
  await shot('images-before-attach');

  await attach(page);
  await shot('images-draft');
  await box(page).fill('what is this?');
  await box(page).press('Enter');

  await expect(page.getByText(/I can see 1 image/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'dot.png' })).toBeVisible();
  await shot('images-sent');

  await page.reload();
  await expect(page.getByRole('img', { name: 'dot.png' })).toBeVisible();
  await expect(page.getByText(/I can see 1 image/)).toBeVisible();
  await shot('images-after-reload');
});

test('sends a message that is only an image', async ({ page }) => {
  const shot = watch(page);
  await signIn(page);
  await attach(page, 'only.png');
  await expect(box(page)).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Send', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/I can see 1 image/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'only.png' })).toBeVisible();
  await shot('images-only');
});

test('keeps the typed text when the upload is refused', async ({ page }) => {
  const shot = watch(page, [413]);
  await page.route('**/attachments?*', route => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          name: 'AttachmentTooLarge',
          message: 'An image may be at most 5242880 bytes',
        },
        response: { statusCode: 413 },
      }),
    });
  });
  await signIn(page);
  await box(page).fill('keep this text');
  await page.locator('input[aria-label="Choose images"]').setInputFiles({
    name: 'big.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('alert')).toHaveText(
    'An image may be at most 5242880 bytes',
  );
  await expect(box(page)).toHaveValue('keep this text');
  await shot('images-upload-failed');
});

test('inserts a message with an image while a run goes on', async ({
  page,
}) => {
  const shot = watch(page);
  await signIn(page);

  await box(page).fill('hold 4');
  await box(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

  await attach(page, 'added.png');
  await box(page).fill('look at this');
  await box(page).press('Enter');

  await expect(page.getByText(/I can see 1 image/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'added.png' })).toBeVisible();
  await shot('images-inserted');
});

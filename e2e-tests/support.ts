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
import { expect, Page } from '@playwright/test';

export const app = process.env.SMOKE_APP ?? 'app';
export const shotSuffix = process.env.SMOKE_SHOT_SUFFIX ?? '';
export const shotDir =
  process.env.SMOKE_SHOT_DIR ?? join('e2e-test-results', app);

function isIgnoredConsoleError(text: string, statuses: number[]): boolean {
  const refused =
    /Failed to load resource: the server responded with a status of (\d+)/.exec(
      text,
    );
  if (refused && [401, 400, ...statuses].includes(Number(refused[1]))) {
    return true;
  }
  // React warnings of the Backstage packages (for example findDOMNode in
  // Material UI 4) are not ours; a warning that names this plugin is.
  const fromOurCode = /plugins\/ai-chat|backstage-plugin-ai-chat/.test(text);
  return text.startsWith('Warning: ') && !fromOurCode;
}

/**
 * Collects the errors of the page. `refusals` are the statuses that the test
 * expects the backend to answer with (a 409 is no error in a test of it).
 * Returns the function that takes a screenshot, once the answer is complete
 * and no error has happened.
 */
export function watch(page: Page, refusals: number[] = []) {
  const errors: string[] = [];
  page.on('console', msg => {
    if (
      msg.type() === 'error' &&
      !isIgnoredConsoleError(msg.text(), refusals)
    ) {
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

/** A screenshot of the page as it is, without waiting for the answer to end. */
export async function snapshot(page: Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({
    path: join(shotDir, `${name}${shotSuffix}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

export async function signIn(page: Page) {
  await page.goto('/');
  const enter = page.getByRole('button', { name: 'Enter' });
  await expect(enter).toBeVisible();
  await enter.click();
  // The sign-in is done when the sign-in page is gone.
  await expect(enter).toBeHidden();
  await page.goto('/ai-chat');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
}

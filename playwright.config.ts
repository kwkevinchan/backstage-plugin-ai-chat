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

import { defineConfig } from '@playwright/test';

/**
 * Smoke test of one development app against the development backend, with
 * the scripted model server (scripts/fake-llm.mjs), so that no API key or
 * network is needed.
 *
 *   SMOKE_APP=app yarn test:e2e        # legacy frontend system
 *   SMOKE_APP=app-next yarn test:e2e   # new frontend system
 *
 * Screenshots of every step go to SMOKE_SHOT_DIR (default
 * e2e-test-results/<app>); SMOKE_SHOT_SUFFIX is added to their names.
 * SMOKE_APP_URL and SMOKE_BACKEND_URL point at
 * servers on other ports (start them yourself, with the same ports in the
 * app config); FAKE_LLM_PORT moves the scripted model server (and the
 * backend reaches it with AI_CHAT_BASE_URL).
 *
 * Outside CI a backend that already runs is used as it is: start it with
 * APP_CONFIG_aiChat_llm_images=true, or the image tests find no Attach button.
 */
const app = process.env.SMOKE_APP ?? 'app';
const appUrl = process.env.SMOKE_APP_URL ?? 'http://localhost:3000';
const backendUrl = process.env.SMOKE_BACKEND_URL ?? 'http://localhost:7007';
const llmPort = process.env.FAKE_LLM_PORT ?? '4010';
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e-tests',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `e2e-test-report/${app}` }],
  ],
  webServer: [
    {
      command: 'node scripts/fake-llm.mjs',
      url: `http://127.0.0.1:${llmPort}/health`,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      command: `yarn workspace ${app} start`,
      url: appUrl,
      reuseExistingServer: !ci,
      timeout: 600_000,
    },
    {
      command: 'yarn workspace backend start',
      url: `${backendUrl}/.backstage/health/v1/readiness`,
      reuseExistingServer: !ci,
      timeout: 600_000,
      // The image tests attach a picture. Images stay off in the committed
      // app config; this turns them on for the backend that this file starts.
      env: { ...process.env, APP_CONFIG_aiChat_llm_images: 'true' },
    },
  ],
  use: {
    baseURL: appUrl,
    // SMOKE_COLOR_SCHEME=dark runs the app with the dark theme of the OS.
    colorScheme: process.env.SMOKE_COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: `node_modules/.cache/e2e-test-results/${app}`,
  projects: [{ name: app }],
});

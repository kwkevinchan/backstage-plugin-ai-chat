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

import { createBackend } from '@backstage/backend-defaults';
import { devActionsPlugin } from './devActions';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));

// Sign-in with the guest provider only.
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// The catalog registers actions (get-catalog-entity, register-entity, ...).
backend.add(import('@backstage/plugin-catalog-backend'));

// The chat. It lists the actions of the plugins in
// backend.actions.pluginSources.
backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
// Example of a backend module: one agent and one context provider.
backend.add(
  import('@kwkevinchan/backstage-plugin-ai-chat-backend-module-example'),
);

// Development only: one read-only action and two that change something, to
// try the approval without another action source.
backend.add(devActionsPlugin);

backend.start();

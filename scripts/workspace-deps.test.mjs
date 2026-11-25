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

/**
 * The directions `yarn constraints` enforces for the extension package.
 * `yarn.config.cjs` calls the same function.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { workspaceDependencyError } = createRequire(import.meta.url)(
  './workspace-deps.cjs',
);

const node = '@kwkevinchan/backstage-plugin-ai-chat-node';
const host = '@kwkevinchan/backstage-plugin-ai-chat-backend';
const harness = '@kwkevinchan/ai-chat-harness';
const example = '@kwkevinchan/backstage-plugin-ai-chat-backend-module-example';

test('rejects a backend module that depends on the host or the harness, and any new direction except the three', () => {
  const moduleEdge = to =>
    workspaceDependencyError({
      from: example,
      to,
      backendRole: true,
      role: 'backend-plugin-module',
      pluginId: 'ai-chat',
    });

  assert.match(moduleEdge(host), /ai-chat-node/);
  assert.match(moduleEdge(harness), /ai-chat-node/);
  assert.equal(moduleEdge(node), undefined);
  assert.match(
    workspaceDependencyError({
      from: node,
      to: host,
      backendRole: true,
      role: 'node-library',
      pluginId: 'ai-chat',
    }),
    /ai-chat-harness/,
  );
  assert.equal(
    workspaceDependencyError({
      from: node,
      to: harness,
      backendRole: true,
      role: 'node-library',
      pluginId: 'ai-chat',
    }),
    undefined,
  );
  assert.equal(
    workspaceDependencyError({
      from: host,
      to: node,
      backendRole: true,
      role: 'backend-plugin',
      pluginId: 'ai-chat',
    }),
    undefined,
  );
  assert.match(
    workspaceDependencyError({
      from: '@kwkevinchan/backstage-plugin-ai-chat',
      to: node,
      backendRole: false,
      role: 'frontend-plugin',
      pluginId: 'ai-chat',
    }),
    /must not depend/,
  );
  assert.match(
    workspaceDependencyError({
      from: harness,
      to: node,
      backendRole: true,
      role: 'node-library',
    }),
    /must not depend/,
  );
});

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
 * Which published package of this repository may depend on which other one.
 * `yarn.config.cjs` asks this for every workspace dependency. A returned
 * string is the constraint error; `undefined` allows the edge.
 *
 * The three directions added for the extension point are `ai-chat-node` to
 * the harness, the backend plugin to `ai-chat-node`, and a backend module of
 * this plugin to `ai-chat-node`. Nothing else may use those packages.
 */

const BACKEND_CORE = '@kwkevinchan/backstage-plugin-ai-chat-backend';
const FRONTEND_CORE = '@kwkevinchan/backstage-plugin-ai-chat';
const HARNESS = '@kwkevinchan/ai-chat-harness';
const COMMON = '@kwkevinchan/backstage-plugin-ai-chat-common';
const NODE_LIB = '@kwkevinchan/backstage-plugin-ai-chat-node';

const CORE = new Set([BACKEND_CORE, FRONTEND_CORE, HARNESS, COMMON]);

/**
 * @param {{
 *   from: string,
 *   to: string,
 *   backendRole: boolean,
 *   role?: string,
 *   pluginId?: string,
 * }} edge
 * @returns {string | undefined}
 */
function workspaceDependencyError(edge) {
  const { from, to, backendRole, role, pluginId } = edge;
  const aiChatModule =
    role === 'backend-plugin-module' && pluginId === 'ai-chat';

  if (
    from === BACKEND_CORE &&
    (to === HARNESS || to === COMMON || to === NODE_LIB)
  ) {
    return undefined;
  }
  if (from === FRONTEND_CORE && to === COMMON) return undefined;
  if (from === NODE_LIB && to === HARNESS) return undefined;
  if (aiChatModule && to === NODE_LIB) return undefined;

  if (from === NODE_LIB) {
    return `${NODE_LIB} may only depend on ${HARNESS} of this repository, not ${to}`;
  }
  if (aiChatModule) {
    return `${from} may only depend on ${NODE_LIB} of this repository, not ${to}`;
  }
  if (CORE.has(from)) {
    return `${from} must not depend on other packages of this repository (${to})`;
  }
  const core = backendRole ? BACKEND_CORE : FRONTEND_CORE;
  if (to !== core) {
    return `${from} may only depend on ${core} of this repository, not ${to}`;
  }
  return undefined;
}

module.exports = {
  BACKEND_CORE,
  FRONTEND_CORE,
  HARNESS,
  COMMON,
  NODE_LIB,
  workspaceDependencyError,
};

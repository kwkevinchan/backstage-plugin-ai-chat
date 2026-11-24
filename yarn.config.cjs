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

// @ts-check
/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types');

const REPO_URL = 'https://github.com/kwkevinchan/backstage-plugin-ai-chat';
const SCOPE = '@kwkevinchan/';
const NPMJS = 'https://registry.npmjs.org/';

const BACKEND_ROLES = new Set([
  'backend',
  'backend-plugin',
  'backend-plugin-module',
  'node-library',
]);
const FRONTEND_ROLES = new Set([
  'frontend',
  'frontend-plugin',
  'frontend-plugin-module',
  'web-library',
]);

/** Packages that only make sense on the Node side. */
const isNodeOnlyDep = name =>
  /^@backstage\/backend-/.test(name) ||
  /^@backstage\/plugin-[a-z-]+-node$/.test(name) ||
  /^(express|express-promise-router|knex)$/.test(name);

/** Packages that only make sense in the browser. */
const isWebOnlyDep = name =>
  /^@backstage\/(core-|frontend-|app-|ui$)/.test(name) ||
  /^@backstage\/plugin-[a-z-]+-react$/.test(name) ||
  /^(react|react-dom|react-router|react-router-dom)$/.test(name) ||
  /^@material-ui\//.test(name) ||
  /^@mui\//.test(name);

const roleOf = workspace => workspace.manifest.backstage?.role;

/**
 * The plugin ships one backend and one frontend package. The frontend
 * depends on the react package. Another frontend package depends only on
 * that react package, not on the host plugin.
 */
const BACKEND_CORE = '@kwkevinchan/backstage-plugin-ai-chat-backend';
const FRONTEND_CORE = '@kwkevinchan/backstage-plugin-ai-chat';
const AI_CHAT_REACT = '@kwkevinchan/backstage-plugin-ai-chat-react';

/**
 * The framework-free core of the agent loop. It does not know Backstage, so
 * no @backstage/* package and no Node-only package (express, knex) is a
 * runtime dependency (dev dependencies, such as the CLI that builds it, are
 * fine).
 */
const HARNESS = '@kwkevinchan/ai-chat-harness';
const COMMON = '@kwkevinchan/backstage-plugin-ai-chat-common';

module.exports = defineConfig({
  async constraints({ Yarn }) {
    const byIdent = new Map(Yarn.workspaces().map(w => [w.ident, w]));

    // Published packages of one plugin list each other in
    // backstage.pluginPackages (used by the Backstage CLI and tooling).
    // Modules are left out, those of this plugin (Zigflow) and those of
    // other plugins (Scaffolder).
    const isModule = workspace => /-module$/.test(roleOf(workspace) ?? '');
    const packagesByPluginId = new Map();
    for (const workspace of Yarn.workspaces()) {
      const pluginId = workspace.manifest.backstage?.pluginId;
      if (!pluginId || workspace.manifest.private === true) continue;
      if (isModule(workspace)) continue;
      const list = packagesByPluginId.get(pluginId) ?? [];
      list.push(workspace.ident);
      packagesByPluginId.set(pluginId, list);
    }
    for (const workspace of Yarn.workspaces()) {
      const pluginId = workspace.manifest.backstage?.pluginId;
      if (!pluginId || workspace.manifest.private === true) continue;
      if (isModule(workspace)) continue;
      workspace.set(
        'backstage.pluginPackages',
        [...packagesByPluginId.get(pluginId)].sort(),
      );
    }

    for (const workspace of Yarn.workspaces()) {
      const isPrivate = workspace.manifest.private === true;
      const isRoot = workspace.cwd === '.';

      // Every workspace is Apache-2.0.
      workspace.set('license', 'Apache-2.0');

      if (isRoot || isPrivate) continue;

      // Published packages: npmjs only, under our scope, pointing at this repo.
      if (!workspace.ident?.startsWith(SCOPE)) {
        workspace.error(`Published packages must use the ${SCOPE} scope`);
      }
      workspace.set('repository.type', 'git');
      workspace.set('repository.url', REPO_URL);
      workspace.set('repository.directory', workspace.cwd);
      const registry = workspace.manifest.publishConfig?.registry;
      if (registry !== undefined && registry !== NPMJS) {
        workspace.error(`publishConfig.registry must be ${NPMJS} or unset`);
      }
    }

    for (const dep of Yarn.dependencies()) {
      const workspace = dep.workspace;
      const isPublished =
        workspace.manifest.private !== true && workspace.cwd !== '.';
      const target = byIdent.get(dep.ident);

      // Packages from our scope must come from this workspace (no private packages).
      if (dep.ident.startsWith(SCOPE) && !target) {
        dep.error(
          `${dep.ident} is not part of this repository; depending on packages outside it is not allowed`,
        );
      }

      // Published packages: no private workspaces. The backend depends on
      // the harness and common. The frontend depends on common and the react
      // package. The react package depends on common. Another frontend
      // package depends only on the react package, not on the host. A
      // backend package that is not the backend itself depends only on the
      // backend.
      if (isPublished && target && dep.type !== 'devDependencies') {
        const isCore = [BACKEND_CORE, FRONTEND_CORE, HARNESS, COMMON].includes(
          workspace.ident,
        );
        if (target.manifest.private === true) {
          dep.error(
            `Published packages must not depend on the private package ${dep.ident}`,
          );
        } else if (
          workspace.ident === BACKEND_CORE &&
          (dep.ident === HARNESS || dep.ident === COMMON)
        ) {
          // The backend plugin is built on the harness and the common types.
        } else if (
          workspace.ident === FRONTEND_CORE &&
          (dep.ident === COMMON || dep.ident === AI_CHAT_REACT)
        ) {
          // The frontend plugin shares the API types and renders the panel.
        } else if (workspace.ident === AI_CHAT_REACT && dep.ident === COMMON) {
          // The react package shares the page-context checks.
        } else if (isCore || workspace.ident === AI_CHAT_REACT) {
          dep.error(
            `${workspace.ident} must not depend on other packages of this repository (${dep.ident})`,
          );
        } else if (!BACKEND_ROLES.has(roleOf(workspace))) {
          if (dep.ident !== AI_CHAT_REACT) {
            dep.error(
              `${workspace.ident} may only depend on ${AI_CHAT_REACT} of this repository, not ${dep.ident}`,
            );
          }
        } else if (dep.ident !== BACKEND_CORE) {
          dep.error(
            `${workspace.ident} may only depend on ${BACKEND_CORE} of this repository, not ${dep.ident}`,
          );
        }
      }

      // The harness core knows nothing of Backstage.
      if (
        workspace.ident === HARNESS &&
        dep.type !== 'devDependencies' &&
        (dep.ident.startsWith('@backstage/') || isNodeOnlyDep(dep.ident))
      ) {
        dep.error(`${HARNESS} must not depend on ${dep.ident}`);
      }

      // Published packages must not use local or git protocols.
      if (
        isPublished &&
        /^(link|portal|file|git|github|https?):/.test(dep.range)
      ) {
        dep.error(`Published packages must not use ${dep.range}`);
      }
      // Never resolve anything from GitHub Packages.
      if (/npm\.pkg\.github\.com/.test(dep.range)) {
        dep.error('Dependencies must not come from GitHub Packages');
      }

      const role = roleOf(workspace);
      const targetRole = target ? roleOf(target) : undefined;

      // Frontend packages: no Node-side workspaces or Node-only packages.
      if (
        FRONTEND_ROLES.has(role) &&
        role !== 'frontend' &&
        dep.type !== 'devDependencies'
      ) {
        if (
          (targetRole && BACKEND_ROLES.has(targetRole)) ||
          isNodeOnlyDep(dep.ident)
        ) {
          dep.error(`frontend packages must not depend on ${dep.ident}`);
        }
      }

      // Backend packages: no frontend workspaces or browser-only packages.
      // (A backend may bundle the app it serves.)
      const servesApp = role === 'backend' && targetRole === 'frontend';
      if (
        BACKEND_ROLES.has(role) &&
        dep.type !== 'devDependencies' &&
        !servesApp
      ) {
        if (
          (targetRole && FRONTEND_ROLES.has(targetRole)) ||
          isWebOnlyDep(dep.ident)
        ) {
          dep.error(`backend packages must not depend on ${dep.ident}`);
        }
      }

      // Workspace dependencies use the workspace protocol.
      if (
        target &&
        dep.type !== 'peerDependencies' &&
        !dep.range.startsWith('workspace:')
      ) {
        dep.update('workspace:^');
      }
    }

    // One range for each external runtime dependency across published packages.
    const ranges = new Map();
    for (const dep of Yarn.dependencies({ type: 'dependencies' })) {
      if (byIdent.has(dep.ident)) continue;
      if (dep.workspace.manifest.private === true || dep.workspace.cwd === '.')
        continue;
      const seen = ranges.get(dep.ident);
      if (seen === undefined) ranges.set(dep.ident, dep.range);
      else if (seen !== dep.range) {
        dep.error(`${dep.ident} uses ${dep.range} here but ${seen} elsewhere`);
      }
    }
  },
});

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

import type { PermissionsRegistryService } from '@backstage/backend-plugin-api';
import type { PermissionCriteria } from '@backstage/plugin-permission-common';
import {
  createConditionAuthorizer,
  createConditionExports,
  createPermissionResourceRef,
  createPermissionRule,
} from '@backstage/plugin-permission-node';
import { aiChatToolsetUsePermission } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { z } from 'zod';
import type { AgentCatalog } from '../../application/ports';

/**
 * What a condition of `ai-chat.toolset.use` sees of one toolset.
 *
 * @public
 */
export type ToolsetAccess = { id: string };

/**
 * A fragment the toolset rule turns into.
 *
 * @public
 */
export type ToolsetAccessQuery = { toolsetId: string };

/** The resource type of {@link aiChatToolsetUsePermission}. */
export const toolsetAccessResourceRef = createPermissionResourceRef<
  ToolsetAccess,
  ToolsetAccessQuery
>().with({
  pluginId: 'ai-chat',
  resourceType: 'ai-chat-toolset',
});

/** The toolset is one of the given ids. The rule name is `IS_TOOLSET`. */
export const isToolsetRule = createPermissionRule({
  name: 'IS_TOOLSET',
  description: 'Allow when the toolset is one of the given toolset ids',
  resourceRef: toolsetAccessResourceRef,
  paramsSchema: z.object({
    /** Toolset ids of `aiChat.toolsets`. */
    toolsetIds: z.array(z.string()),
  }),
  apply(resource, params) {
    return params.toolsetIds.includes(resource.id);
  },
  toQuery(params): PermissionCriteria<ToolsetAccessQuery> {
    const queries = params.toolsetIds.map(toolsetId => ({ toolsetId }));
    if (queries.length === 0) return { toolsetId: '' };
    if (queries.length === 1) return queries[0];
    const [first, ...rest] = queries;
    return { anyOf: [first, ...rest] };
  },
});

const conditionExports = createConditionExports({
  resourceRef: toolsetAccessResourceRef,
  rules: { isToolset: isToolsetRule },
});

/**
 * The condition of `ai-chat.toolset.use`: `isToolset` takes `{ toolsetIds }`.
 * The rule name on the condition is `IS_TOOLSET`.
 *
 * @public
 */
export const aiChatToolsetConditions = conditionExports.conditions;

/**
 * Wraps conditions of `ai-chat.toolset.use` in a conditional decision.
 *
 * @public
 */
export const createAiChatToolsetConditionalDecision =
  conditionExports.createConditionalDecision;

/**
 * Registers the toolset resource, the use permission and the toolset rule.
 * Returns the authorizer over the registered rules.
 */
export function registerToolsetAccess(
  registry: PermissionsRegistryService,
  deps: { agents: Pick<AgentCatalog, 'toolsets'> },
): ReturnType<typeof createConditionAuthorizer<ToolsetAccess>> {
  registry.addResourceType({
    resourceRef: toolsetAccessResourceRef,
    permissions: [aiChatToolsetUsePermission],
    rules: [isToolsetRule],
    getResources: async resourceRefs => {
      const ids = new Set(
        (await deps.agents.toolsets()).map(toolset => toolset.id),
      );
      return resourceRefs.map(id => (ids.has(id) ? { id } : undefined));
    },
  });
  return createConditionAuthorizer(
    registry.getPermissionRuleset(toolsetAccessResourceRef),
  );
}

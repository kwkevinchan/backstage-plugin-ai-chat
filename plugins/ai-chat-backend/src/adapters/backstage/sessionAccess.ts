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
import { aiChatSessionReadPermission } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { z } from 'zod';
import type { ShareRepository } from '../../application/ports';
import type { SessionRepository } from '../../application/ports';
import {
  SessionNotFound,
  isSessionOwner,
  shareGrantsRead,
  type Share,
  type Session,
} from '../../domain';

/**
 * What a condition sees of one session: who owns it, and the shares (a
 * cancelled share still listed, so the rule can refuse it). Expiry is not
 * here. An expired share still grants the read; the items freeze elsewhere.
 *
 * @public
 */
export type SessionAccess = {
  ownerRef: string;
  shares: ReadonlyArray<{ subjectRef: string; revokedAt?: string }>;
};

/**
 * A fragment a rule turns into. `revoked: false` keeps a cancelled share out.
 *
 * @public
 */
export type SessionAccessQuery =
  | { ownerRef: string }
  | { subjectRef: string; revoked: false };

/** The resource type of {@link aiChatSessionReadPermission}. */
export const sessionAccessResourceRef = createPermissionResourceRef<
  SessionAccess,
  SessionAccessQuery
>().with({
  pluginId: 'ai-chat',
  resourceType: 'ai-chat-session',
});

const userRefs = z.object({
  /** User entity refs. A group ref does not make the caller the owner. */
  userRefs: z.array(z.string()),
});

const subjectRefs = z.object({
  /** The user and the groups the caller belongs to. */
  subjectRefs: z.array(z.string()),
});

/**
 * `ownerRef` is one of the given user entity refs. The rule name is
 * `IS_SESSION_OWNER`.
 */
export const isSessionOwnerRule = createPermissionRule({
  name: 'IS_SESSION_OWNER',
  description: 'Allow when ownerRef is one of the given user entity refs',
  resourceRef: sessionAccessResourceRef,
  paramsSchema: userRefs,
  apply(resource, params) {
    return params.userRefs.some(userRef =>
      isSessionOwner({ ownerRef: resource.ownerRef }, userRef),
    );
  },
  toQuery(params) {
    return matchAny('ownerRef', params.userRefs);
  },
});

/**
 * A share that is not cancelled names the user or one of their groups. The
 * rule name is `IS_SHARED_WITH`.
 */
export const isSharedWithRule = createPermissionRule({
  name: 'IS_SHARED_WITH',
  description:
    'Allow when a share that is not revoked names one of the given user or group refs',
  resourceRef: sessionAccessResourceRef,
  paramsSchema: subjectRefs,
  apply(resource, params) {
    return resource.shares.some(share =>
      shareGrantsRead(
        { subjectRef: share.subjectRef, revokedAt: share.revokedAt },
        { userRef: '', ownershipRefs: params.subjectRefs },
      ),
    );
  },
  toQuery(params) {
    return matchAny('subjectRef', params.subjectRefs);
  },
});

const conditionExports = createConditionExports({
  resourceRef: sessionAccessResourceRef,
  rules: {
    isSessionOwner: isSessionOwnerRule,
    isSharedWith: isSharedWithRule,
  },
});

/**
 * Factories for the two conditions of `ai-chat.session.read`.
 * `isSessionOwner` takes `{ userRefs }` and `isSharedWith` takes
 * `{ subjectRefs }`. The rule names on the conditions are `IS_SESSION_OWNER`
 * and `IS_SHARED_WITH`.
 *
 * @public
 */
export const aiChatSessionConditions = conditionExports.conditions;

/**
 * Wraps conditions of `ai-chat.session.read` in a conditional decision.
 *
 * @public
 */
export const createAiChatConditionalDecision =
  conditionExports.createConditionalDecision;

/** The permission resource the rules and `getResources` share. */
export function sessionAccessFrom(
  session: Pick<Session, 'ownerRef'>,
  shares: readonly Share[],
): SessionAccess {
  return {
    ownerRef: session.ownerRef,
    shares: shares.map(share => ({
      subjectRef: share.subjectRef,
      ...(share.revokedAt !== undefined ? { revokedAt: share.revokedAt } : {}),
    })),
  };
}

/**
 * Loads one session per ref for the permission backend. A missing session is
 * `undefined`, which refuses the condition.
 */
export async function loadSessionAccess(
  deps: { sessions: SessionRepository; shares: ShareRepository },
  refs: readonly string[],
): Promise<Array<SessionAccess | undefined>> {
  return Promise.all(refs.map(ref => loadOne(deps, ref)));
}

async function loadOne(
  deps: { sessions: SessionRepository; shares: ShareRepository },
  sessionId: string,
): Promise<SessionAccess | undefined> {
  try {
    const session = await deps.sessions.get(sessionId);
    const shares = await deps.shares.listBySession(sessionId);
    return sessionAccessFrom(session, shares);
  } catch (error) {
    if (error instanceof SessionNotFound) return undefined;
    throw error;
  }
}

/**
 * Registers the session resource, the read permission and the two rules.
 * Returns the authorizer over the registered rules.
 */
export function registerSessionAccess(
  registry: PermissionsRegistryService,
  deps: { sessions: SessionRepository; shares: ShareRepository },
): ReturnType<typeof createConditionAuthorizer<SessionAccess>> {
  registry.addResourceType({
    resourceRef: sessionAccessResourceRef,
    permissions: [aiChatSessionReadPermission],
    rules: [isSessionOwnerRule, isSharedWithRule],
    getResources: resourceRefs => loadSessionAccess(deps, resourceRefs),
  });
  return createConditionAuthorizer(
    registry.getPermissionRuleset(sessionAccessResourceRef),
  );
}

function matchAny(
  key: 'ownerRef' | 'subjectRef',
  refs: readonly string[],
): PermissionCriteria<SessionAccessQuery> {
  if (refs.length === 0) {
    return key === 'ownerRef'
      ? { ownerRef: '' }
      : { subjectRef: '', revoked: false };
  }
  const queries: SessionAccessQuery[] = refs.map(ref =>
    key === 'ownerRef'
      ? { ownerRef: ref }
      : { subjectRef: ref, revoked: false },
  );
  if (queries.length === 1) return queries[0];
  const [first, ...rest] = queries;
  return { anyOf: [first, ...rest] };
}

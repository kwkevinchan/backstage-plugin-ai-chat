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

import type { PermissionsService } from '@backstage/backend-plugin-api';
import {
  AuthorizeResult,
  type PolicyDecision,
} from '@backstage/plugin-permission-common';
import { createConditionAuthorizer } from '@backstage/plugin-permission-node';
import { aiChatSessionReadPermission } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { Principal, Share } from '../../domain';
import { PermissionAccessControl } from './PermissionAccessControl';
import {
  aiChatSessionConditions,
  createAiChatConditionalDecision,
  isSessionOwnerRule,
  isSharedWithRule,
} from './sessionAccess';

const session = { id: 's1', ownerRef: 'user:default/jane' };

function person(userRef: string, groups: string[] = []): Principal {
  return {
    userRef,
    ownershipRefs: [userRef, ...groups],
    credentials: { principal: { type: 'user', userEntityRef: userRef } },
  };
}

const jane = person('user:default/jane');
const bob = person('user:default/bob', ['group:default/team']);
const cara = person('user:default/cara');

function share(partial: Partial<Share> & Pick<Share, 'subjectRef'>): Share {
  return {
    id: 'sh1',
    sessionId: 's1',
    createdBy: 'user:default/jane',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function permissionsReturning(decision: PolicyDecision): PermissionsService {
  return {
    authorize: async () => [{ result: AuthorizeResult.DENY }],
    authorizeConditional: async () => [decision],
  } as unknown as PermissionsService;
}

const authorizer = createConditionAuthorizer([
  isSessionOwnerRule,
  isSharedWithRule,
]);

function control(decision: PolicyDecision) {
  return new PermissionAccessControl({
    permissions: permissionsReturning(decision),
    authorizer,
  });
}

describe('PermissionAccessControl', () => {
  it('DENY refuses the owner', async () => {
    const allowed = await control({
      result: AuthorizeResult.DENY,
    }).canReadSession({ session, principal: jane, shares: [] });
    expect(allowed).toBe(false);
  });

  it('ALLOW falls back to the owner and the shares, so a stranger cannot read', async () => {
    const access = control({ result: AuthorizeResult.ALLOW });
    expect(
      await access.canReadSession({ session, principal: jane, shares: [] }),
    ).toBe(true);
    expect(
      await access.canReadSession({ session, principal: cara, shares: [] }),
    ).toBe(false);
    expect(
      await access.canReadSession({
        session,
        principal: bob,
        shares: [share({ subjectRef: 'group:default/team' })],
      }),
    ).toBe(true);
    expect(
      await access.canReadSession({
        session,
        principal: bob,
        shares: [
          share({
            subjectRef: 'group:default/team',
            revokedAt: '2026-03-01T00:00:00.000Z',
          }),
        ],
      }),
    ).toBe(false);
  });

  it('CONDITIONAL applies only the conditions the policy returned', async () => {
    // The policy bakes the caller's refs into the condition. The authorizer
    // then looks at the resource, not at the principal of this call.
    const onlyOwner = control(
      createAiChatConditionalDecision(
        aiChatSessionReadPermission,
        aiChatSessionConditions.isSessionOwner({
          userRefs: ['user:default/jane'],
        }),
      ),
    );
    expect(
      await onlyOwner.canReadSession({ session, principal: jane, shares: [] }),
    ).toBe(true);
    expect(
      await onlyOwner.canReadSession({
        session: { id: 's1', ownerRef: 'user:default/other' },
        principal: bob,
        shares: [share({ subjectRef: 'user:default/bob' })],
      }),
    ).toBe(false);

    const onlyShare = control(
      createAiChatConditionalDecision(
        aiChatSessionReadPermission,
        aiChatSessionConditions.isSharedWith({
          subjectRefs: ['user:default/bob', 'group:default/team'],
        }),
      ),
    );
    expect(
      await onlyShare.canReadSession({ session, principal: jane, shares: [] }),
    ).toBe(false);
    expect(
      await onlyShare.canReadSession({
        session,
        principal: bob,
        shares: [share({ subjectRef: 'group:default/team' })],
      }),
    ).toBe(true);
    const leftTheGroup = control(
      createAiChatConditionalDecision(
        aiChatSessionReadPermission,
        aiChatSessionConditions.isSharedWith({
          subjectRefs: ['user:default/bob'],
        }),
      ),
    );
    expect(
      await leftTheGroup.canReadSession({
        session,
        principal: person('user:default/bob'),
        shares: [share({ subjectRef: 'group:default/team' })],
      }),
    ).toBe(false);
  });
});

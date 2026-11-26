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
import {
  aiChatSessionReadPermission,
  aiChatToolsetUsePermission,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { Principal, Share } from '../../domain';
import { PermissionAccessControl } from './PermissionAccessControl';
import {
  aiChatSessionConditions,
  createAiChatConditionalDecision,
  isSessionOwnerRule,
  isSharedWithRule,
} from './sessionAccess';
import {
  aiChatToolsetConditions,
  createAiChatToolsetConditionalDecision,
  isToolsetRule,
} from './toolsetAccess';

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
    authorizeConditional: async (
      ...args: Parameters<PermissionsService['authorizeConditional']>
    ) => {
      const [requests, options] = args;
      if (
        requests.length !== 1 ||
        (requests[0]?.permission !== aiChatSessionReadPermission &&
          requests[0]?.permission !== aiChatToolsetUsePermission)
      ) {
        throw new Error('authorizeConditional received the wrong permission');
      }
      if (options?.credentials === undefined) {
        throw new Error('authorizeConditional received no credentials');
      }
      return [decision];
    },
  } as unknown as PermissionsService;
}

const authorizer = createConditionAuthorizer([
  isSessionOwnerRule,
  isSharedWithRule,
]);
const toolsetAuthorizer = createConditionAuthorizer([isToolsetRule]);

function control(decision: PolicyDecision) {
  return new PermissionAccessControl({
    permissions: permissionsReturning(decision),
    authorizer,
    toolsetAuthorizer,
  });
}

describe('PermissionAccessControl', () => {
  it('authorizeConditional is called with the read permission and the principal credentials', async () => {
    const seen: unknown[] = [];
    const permissions = {
      authorize: async () => [{ result: AuthorizeResult.DENY }],
      authorizeConditional: async (requests: unknown, options: unknown) => {
        seen.push({ requests, options });
        return [{ result: AuthorizeResult.ALLOW }];
      },
    } as unknown as PermissionsService;
    await new PermissionAccessControl({
      permissions,
      authorizer,
      toolsetAuthorizer,
    }).canReadSession({ session, principal: jane, shares: [] });
    expect(seen).toEqual([
      {
        requests: [{ permission: aiChatSessionReadPermission }],
        options: { credentials: jane.credentials },
      },
    ]);
  });

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

  describe('usableToolsets (T-08)', () => {
    const toolsetIds = ['catalog', 'temporal', 'web'];

    it('asks for the toolset permission with the credentials of the principal', async () => {
      const seen: unknown[] = [];
      const permissions = {
        authorize: async () => [{ result: AuthorizeResult.DENY }],
        authorizeConditional: async (requests: unknown, options: unknown) => {
          seen.push({ requests, options });
          return [{ result: AuthorizeResult.ALLOW }];
        },
      } as unknown as PermissionsService;
      await new PermissionAccessControl({
        permissions,
        authorizer,
        toolsetAuthorizer,
      }).usableToolsets({ principal: jane, toolsetIds });
      expect(seen).toEqual([
        {
          requests: [{ permission: aiChatToolsetUsePermission }],
          options: { credentials: jane.credentials },
        },
      ]);
    });

    it('ALLOW gives every toolset, as when the framework is off', async () => {
      expect(
        await control({ result: AuthorizeResult.ALLOW }).usableToolsets({
          principal: jane,
          toolsetIds,
        }),
      ).toEqual(toolsetIds);
    });

    it('DENY gives none', async () => {
      expect(
        await control({ result: AuthorizeResult.DENY }).usableToolsets({
          principal: jane,
          toolsetIds,
        }),
      ).toEqual([]);
    });

    it('CONDITIONAL applies IS_TOOLSET to each toolset', async () => {
      const decision = createAiChatToolsetConditionalDecision(
        aiChatToolsetUsePermission,
        aiChatToolsetConditions.isToolset({ toolsetIds: ['web', 'catalog'] }),
      );
      expect(
        await control(decision).usableToolsets({ principal: jane, toolsetIds }),
      ).toEqual(['catalog', 'web']);
    });

    it('a failure of the permission backend throws instead of allowing', async () => {
      const permissions = {
        authorize: async () => [],
        authorizeConditional: async () => {
          throw new Error('permission backend is down');
        },
      } as unknown as PermissionsService;
      await expect(
        new PermissionAccessControl({
          permissions,
          authorizer,
          toolsetAuthorizer,
        }).usableToolsets({ principal: jane, toolsetIds }),
      ).rejects.toThrow('permission backend is down');
    });
  });
});

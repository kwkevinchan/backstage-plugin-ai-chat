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
import { SessionNotFound, type Share } from '../../domain';
import {
  isSessionOwnerRule,
  isSharedWithRule,
  loadSessionAccess,
  registerSessionAccess,
  sessionAccessResourceRef,
} from './sessionAccess';

describe('registerSessionAccess', () => {
  it('registers the read permission and the two rules', () => {
    const added: Array<{
      permissions?: { name: string }[];
      rules: { name: string }[];
      resourceType: string;
    }> = [];
    const registry = {
      addResourceType(options: {
        permissions?: { name: string }[];
        rules: { name: string }[];
        resourceRef: { resourceType: string };
      }) {
        added.push({
          permissions: options.permissions,
          rules: options.rules,
          resourceType: options.resourceRef.resourceType,
        });
      },
      getPermissionRuleset() {
        return {
          getRuleByName(name: string) {
            const rule = [isSessionOwnerRule, isSharedWithRule].find(
              one => one.name === name,
            );
            if (!rule) throw new Error(name);
            return rule;
          },
        };
      },
    };
    registerSessionAccess(registry as unknown as PermissionsRegistryService, {
      sessions: {
        get: async () => {
          throw new SessionNotFound('s1');
        },
      } as never,
      shares: { listBySession: async () => [] } as never,
    });
    expect(added).toEqual([
      {
        resourceType: sessionAccessResourceRef.resourceType,
        permissions: [
          {
            name: 'ai-chat.session.read',
            attributes: { action: 'read' },
            type: 'resource',
            resourceType: 'ai-chat-session',
          },
        ],
        rules: [isSessionOwnerRule, isSharedWithRule],
      },
    ]);
    expect(added[0].rules.map(rule => rule.name).sort()).toEqual([
      'IS_SESSION_OWNER',
      'IS_SHARED_WITH',
    ]);
  });

  it('loads a session for the permission backend and returns nothing when it is missing', async () => {
    const shares: Share[] = [
      {
        id: 'sh1',
        sessionId: 's1',
        subjectRef: 'group:default/team',
        createdBy: 'user:default/jane',
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    const deps = {
      sessions: {
        get: async (id: string) => {
          if (id === 'missing') throw new SessionNotFound(id);
          return { id, ownerRef: 'user:default/jane' };
        },
      },
      shares: { listBySession: async () => shares },
    };
    const loaded = await loadSessionAccess(deps as never, ['s1', 'missing']);
    expect(loaded).toEqual([
      {
        ownerRef: 'user:default/jane',
        shares: [
          {
            subjectRef: 'group:default/team',
            revokedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
      },
      undefined,
    ]);
  });
});

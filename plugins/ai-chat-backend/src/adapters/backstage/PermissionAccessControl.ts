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

import type {
  BackstageCredentials,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { PolicyDecision } from '@backstage/plugin-permission-common';
import { aiChatSessionReadPermission } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AccessControl } from '../../application/ports';
import {
  allowsSessionRead,
  type Principal,
  type Share,
  type Session,
} from '../../domain';
import { sessionAccessFrom, type SessionAccess } from './sessionAccess';

/**
 * `AccessControl` on the Backstage permission framework (SH-05).
 *
 * ALLOW is what this app returns when the framework is off. An admin must not
 * read a conversation, so ALLOW falls back to the owner and the shares. DENY
 * refuses even the owner. CONDITIONAL applies only the conditions the policy
 * returned.
 */
export class PermissionAccessControl implements AccessControl {
  constructor(
    private readonly deps: {
      permissions: PermissionsService;
      authorizer: (
        decision: PolicyDecision,
        resource: SessionAccess | undefined,
      ) => boolean;
    },
  ) {}

  async canReadSession(input: {
    session: Pick<Session, 'id' | 'ownerRef'>;
    principal: Principal;
    shares: readonly Share[];
  }): Promise<boolean> {
    const [decision] = await this.deps.permissions.authorizeConditional(
      [{ permission: aiChatSessionReadPermission }],
      {
        credentials: input.principal.credentials as BackstageCredentials,
      },
    );
    if (decision.result === AuthorizeResult.DENY) return false;
    if (decision.result === AuthorizeResult.CONDITIONAL) {
      return this.deps.authorizer(
        decision,
        sessionAccessFrom(input.session, input.shares),
      );
    }
    return allowsSessionRead(input.session, input.principal, input.shares);
  }
}

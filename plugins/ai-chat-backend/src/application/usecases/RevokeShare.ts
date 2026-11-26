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

import { ShareNotFound, assertOwner, type Principal } from '../../domain';
import type { AuditLog, SessionRepository, ShareRepository } from '../ports';
import { auditedShareWrite, shareAuditEvent } from '../shareChanges';

/**
 * The owner cancels a share. The sharee cannot read from the next request
 * on, on every backend: nothing about a share is cached.
 */
export class RevokeShare {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      shares: ShareRepository;
      audit: AuditLog;
    },
  ) {}

  /** Throws `NotSessionOwner`, or `ShareNotFound` also for a cancelled share. */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    shareId: string;
  }): Promise<void> {
    const { sessions, shares, audit } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const share = await shares.get(session.id, input.shareId);
    if (share === undefined || share.revokedAt !== undefined) {
      throw new ShareNotFound(input.shareId);
    }
    await auditedShareWrite(
      audit,
      shareAuditEvent('session-share-revoke', input.principal.userRef, share),
      () => shares.revoke(session.id, share.id),
      () => new ShareNotFound(share.id),
    );
  }
}

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

import type { Clock, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  InvalidShare,
  LiveSharingDisabled,
  ShareNotFound,
  assertOwner,
  liveShareExpiry,
  shareModeOf,
  updatedShareScope,
  type LiveShareLimits,
  type Principal,
  type ShareChange,
} from '../../domain';
import type { AuditLog, SessionRepository, ShareRepository } from '../ports';
import {
  auditedShareWrite,
  latestSeq,
  shareAuditEvent,
  shareViewOf,
  type ShareView,
} from '../shareChanges';

/**
 * The owner changes a share: moves a snapshot to now (SH-08), shows or hides
 * the tool output (SH-02, SH-09), or gives a live share a new expiry (SH-11).
 */
export class UpdateShare {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      shares: ShareRepository;
      items: ItemLog;
      audit: AuditLog;
      clock: Clock;
      live: LiveShareLimits;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `ShareNotFound` (also for a cancelled share),
   * `InvalidShare`, or `LiveSharingDisabled` for a new expiry when the
   * administrator turned live shares off.
   */
  async execute(
    input: {
      principal: Principal;
      sessionId: string;
      shareId: string;
      /** Live only: hours from now. */
      hours?: number;
    } & ShareChange,
  ): Promise<ShareView> {
    const { sessions, shares, items, audit, clock, live } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const share = await shares.get(session.id, input.shareId);
    if (share === undefined || share.revokedAt !== undefined) {
      throw new ShareNotFound(input.shareId);
    }
    if (input.hours !== undefined) {
      if (shareModeOf(share) === 'snapshot') {
        throw new InvalidShare('hours is only for a share that keeps updating');
      }
      if (!live.enabled) throw new LiveSharingDisabled();
    }
    const scope = updatedShareScope(
      share,
      {
        ...(input.refresh !== undefined && { refresh: input.refresh }),
        ...(input.includeToolOutputs !== undefined && {
          includeToolOutputs: input.includeToolOutputs,
        }),
        ...(input.includeLaterToolOutputs !== undefined && {
          includeLaterToolOutputs: input.includeLaterToolOutputs,
        }),
      },
      await latestSeq(items, session.id),
    );
    const expiresAt =
      input.hours !== undefined
        ? liveShareExpiry(clock.now(), input.hours, live)
        : share.expiresAt;
    const updated = await auditedShareWrite(
      audit,
      shareAuditEvent('session-share-update', input.principal.userRef, {
        id: share.id,
        sessionId: share.sessionId,
        subjectRef: share.subjectRef,
        ...scope,
        ...(expiresAt !== undefined && { expiresAt }),
      }),
      () =>
        shares.update(session.id, share.id, {
          ...scope,
          ...(input.hours !== undefined && { expiresAt }),
        }),
      () => new ShareNotFound(share.id),
    );
    return shareViewOf(updated, clock);
  }
}

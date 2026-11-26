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

import type { Clock, IdGenerator, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  InvalidShare,
  LiveSharingDisabled,
  assertOwner,
  createShareScope,
  liveShareExpiry,
  MAX_SUBJECT_REF_LENGTH,
  normalizeSubjectRef,
  type LiveShareLimits,
  type NewShare,
  type Principal,
  type ShareMode,
} from '../../domain';
import type { AuditLog, SessionRepository, ShareRepository } from '../ports';
import {
  auditedShareWrite,
  latestSeq,
  shareAuditEvent,
  shareViewOf,
  type ShareView,
} from '../shareChanges';

/** The owner shares a session, read-only, with a user or a group (SH-01). */
export class ShareSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      shares: ShareRepository;
      items: ItemLog;
      audit: AuditLog;
      clock: Clock;
      ids: IdGenerator;
      live: LiveShareLimits;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `InvalidShare`, or `LiveSharingDisabled` for a
   * live share when the administrator turned them off.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    subjectRef: string;
    /** `snapshot` by default (D-21). */
    mode?: ShareMode;
    includeToolOutputs?: boolean;
    includeLaterToolOutputs?: boolean;
    /** Live only: the life of the share; `defaultHours` when left out. */
    hours?: number;
  }): Promise<ShareView> {
    const { sessions, shares, items, audit, clock, ids, live } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const subjectRef = normalizeSubjectRef(input.subjectRef);
    if (subjectRef === undefined) {
      throw new InvalidShare(
        'subjectRef must be a user or a group, like user:default/name',
      );
    }
    if (subjectRef.length > MAX_SUBJECT_REF_LENGTH) {
      throw new InvalidShare(
        `subjectRef must be at most ${MAX_SUBJECT_REF_LENGTH} characters`,
      );
    }
    if (subjectRef === session.ownerRef) {
      throw new InvalidShare('A session is not shared with its owner');
    }
    const mode = input.mode ?? 'snapshot';
    if (mode === 'snapshot' && input.hours !== undefined) {
      throw new InvalidShare('hours is only for a share that keeps updating');
    }
    if (mode === 'live' && !live.enabled) throw new LiveSharingDisabled();
    const expiresAt =
      mode === 'live'
        ? liveShareExpiry(clock.now(), input.hours, live)
        : undefined;
    const scope = createShareScope(
      {
        mode,
        ...(input.includeToolOutputs !== undefined && {
          includeToolOutputs: input.includeToolOutputs,
        }),
        ...(input.includeLaterToolOutputs !== undefined && {
          includeLaterToolOutputs: input.includeLaterToolOutputs,
        }),
      },
      await latestSeq(items, session.id),
    );
    const draft: NewShare & { id: string } = {
      id: ids.next(),
      sessionId: session.id,
      subjectRef,
      ...scope,
      ...(expiresAt !== undefined && { expiresAt }),
      createdBy: input.principal.userRef,
    };
    const share = await auditedShareWrite(
      audit,
      shareAuditEvent('session-share', input.principal.userRef, draft),
      () => shares.add(draft),
      () => new InvalidShare('The share was not stored'),
    );
    return shareViewOf(share, clock);
  }
}

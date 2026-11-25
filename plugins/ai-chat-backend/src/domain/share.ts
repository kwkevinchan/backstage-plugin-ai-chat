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

import type { Principal } from './principal';
import { isSessionOwner, type Session } from './session';

/**
 * A read-only share of a session (SH-01). `subjectRef` is `user:…` or
 * `group:…`. There is no role: a share never grants a write.
 *
 * `upToSeq` absent means the share keeps updating. `outputsUpToSeq` absent
 * means every tool output in the visible range is included; `0` means none.
 * `expiresAt` absent means the share does not freeze by time. `revokedAt`
 * set means the share is cancelled.
 */
export type Share = {
  id: string;
  sessionId: string;
  subjectRef: string;
  upToSeq?: number;
  outputsUpToSeq?: number;
  /** ISO 8601. */
  expiresAt?: string;
  createdBy: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Set when the share is cancelled. */
  revokedAt?: string;
};

/**
 * What is stored for a new share. `revokedAt` is never set on create.
 * `expiresAt` is an ISO 8601 instant; `KnexShareRepository.add` stores
 * `new Date(expiresAt).toISOString()` so string comparison stays valid.
 */
export type NewShare = {
  sessionId: string;
  subjectRef: string;
  upToSeq?: number;
  outputsUpToSeq?: number;
  /** ISO 8601 instant. Stored as UTC `toISOString()`. */
  expiresAt?: string;
  createdBy: string;
};

/** Snapshot or live, and the seq of the log at the moment of the share. */
export type ShareScopeInput = {
  mode: 'snapshot' | 'live';
  /** The latest seq of the log when the share is made. `0` is an empty log. */
  atSeq: number;
  /**
   * The tool-output bound. Left out: the default of the mode. `null`: every
   * output in the visible range. A number, including 0, is that bound.
   */
  outputsUpToSeq?: number | null;
};

/** The two seq fields to store. An absent field is stored as null. */
export type ShareScope = {
  upToSeq?: number;
  outputsUpToSeq?: number;
};

/**
 * The seq fields of a new share (SH-09). A live share leaves `upToSeq` empty.
 * When its output bound is not given, the bound is the seq at that moment, so
 * later tool output stays hidden. A snapshot's `upToSeq` is that seq, and an
 * output bound that is not given means every output already inside it (D-13).
 */
export function shareScope(input: ShareScopeInput): ShareScope {
  if (input.mode === 'snapshot') {
    const scope: ShareScope = { upToSeq: input.atSeq };
    if (typeof input.outputsUpToSeq === 'number') {
      scope.outputsUpToSeq = input.outputsUpToSeq;
    }
    return scope;
  }
  if (input.outputsUpToSeq === undefined) {
    return { outputsUpToSeq: input.atSeq };
  }
  if (input.outputsUpToSeq === null) return {};
  return { outputsUpToSeq: input.outputsUpToSeq };
}

/**
 * A share lets this person read when it is not cancelled and its subject is
 * the user or one of the groups in `ownershipRefs`. Expiry does not cancel
 * the read: the content freezes, the read stays. A direct user share still
 * matches after a group is removed from `ownershipRefs`.
 */
export function shareGrantsRead(
  share: Pick<Share, 'subjectRef' | 'revokedAt'>,
  principal: Pick<Principal, 'userRef' | 'ownershipRefs'>,
): boolean {
  if (share.revokedAt !== undefined) return false;
  if (share.subjectRef === principal.userRef) return true;
  return principal.ownershipRefs.includes(share.subjectRef);
}

/**
 * The owner, or someone {@link shareGrantsRead} accepts. This is the rule
 * used when the permission framework allows the action outright (it is off
 * by default) so a stranger still cannot read.
 */
export function allowsSessionRead(
  session: Pick<Session, 'ownerRef'>,
  principal: Pick<Principal, 'userRef' | 'ownershipRefs'>,
  shares: readonly Pick<Share, 'subjectRef' | 'revokedAt'>[],
): boolean {
  if (isSessionOwner(session, principal.userRef)) return true;
  return shares.some(share => shareGrantsRead(share, principal));
}

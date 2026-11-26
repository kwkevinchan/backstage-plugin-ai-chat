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

import { InvalidShare } from './errors';
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
  /** Given when the caller needs the id before the row is written. */
  id?: string;
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

/** `live` when the share has no seq cap, whether or not it has expired. */
export type ShareMode = 'snapshot' | 'live';

export function shareModeOf(share: Pick<Share, 'upToSeq'>): ShareMode {
  return share.upToSeq === undefined ? 'live' : 'snapshot';
}

/** Past `expiresAt` (a later `now`; the same instant is not past it). */
export function isShareExpired(
  share: Pick<Share, 'expiresAt'>,
  now: string,
): boolean {
  return share.expiresAt !== undefined && now > share.expiresAt;
}

const SUBJECT_REF = /^(user|group):(?:([^:/\s]+)\/)?([^:/\s]+)$/i;

/**
 * `user:<namespace>/<name>` or `group:<namespace>/<name>`, with `default`
 * when the namespace is left out, all in lower case like `normalizeEntityRef`:
 * the refs of the user and of their groups (`ownershipRefs`) come lower case,
 * and a share matches them as strings. Anything else is `undefined`.
 */
export function normalizeSubjectRef(ref: string): string | undefined {
  const match = SUBJECT_REF.exec(ref.trim());
  if (!match) return undefined;
  const [, kind, namespace = 'default', name] = match;
  return `${kind}:${namespace}/${name}`.toLowerCase();
}

/** The longest subject ref a share stores, after it is normalized. */
export const MAX_SUBJECT_REF_LENGTH = 255;

/** What the owner asks for when sharing. */
export type ShareRequest = {
  mode: ShareMode;
  /** True by default. False hides every tool output. */
  includeToolOutputs?: boolean;
  /** Live only. True also shows tool output written after the share. */
  includeLaterToolOutputs?: boolean;
};

/**
 * The two seq fields of a new share, from what the owner asks for and the
 * latest seq of the log. Throws `InvalidShare` for a request that is not
 * consistent.
 */
export function createShareScope(
  request: ShareRequest,
  atSeq: number,
): ShareScope {
  const include = request.includeToolOutputs ?? true;
  if (request.mode === 'snapshot' && request.includeLaterToolOutputs) {
    throw new InvalidShare(
      'includeLaterToolOutputs is only for a share that keeps updating',
    );
  }
  if (!include && request.includeLaterToolOutputs) {
    throw new InvalidShare('includeLaterToolOutputs needs includeToolOutputs');
  }
  if (!include) {
    return shareScope({ mode: request.mode, atSeq, outputsUpToSeq: 0 });
  }
  return shareScope({
    mode: request.mode,
    atSeq,
    ...(request.includeLaterToolOutputs && { outputsUpToSeq: null }),
  });
}

/** What the owner changes on a share. */
export type ShareChange = {
  /** Snapshot only: moves the seq cap to the latest seq. */
  refresh?: boolean;
  includeToolOutputs?: boolean;
  /** Live only. */
  includeLaterToolOutputs?: boolean;
};

/**
 * The seq fields of a share after a change, given the latest seq of the log.
 * `includeToolOutputs: false` hides every output. `true` shows every output
 * of a snapshot, and the output up to now of a live share.
 * `includeLaterToolOutputs: true` shows every output of a live share, and
 * `false` stops at now. Throws `InvalidShare` for a change that does not fit
 * the mode.
 */
export function updatedShareScope(
  share: Pick<Share, 'upToSeq' | 'outputsUpToSeq'>,
  change: ShareChange,
  atSeq: number,
): ShareScope {
  const mode = shareModeOf(share);
  if (change.refresh && mode === 'live') {
    throw new InvalidShare('refresh is only for a snapshot');
  }
  if (mode === 'snapshot' && change.includeLaterToolOutputs !== undefined) {
    throw new InvalidShare(
      'includeLaterToolOutputs is only for a share that keeps updating',
    );
  }
  if (
    change.includeToolOutputs === false &&
    change.includeLaterToolOutputs === true
  ) {
    throw new InvalidShare('includeLaterToolOutputs needs includeToolOutputs');
  }
  let upToSeq = share.upToSeq;
  let outputsUpToSeq = share.outputsUpToSeq;
  if (change.refresh) upToSeq = atSeq;
  if (change.includeToolOutputs === false) outputsUpToSeq = 0;
  if (change.includeToolOutputs === true) {
    outputsUpToSeq = mode === 'snapshot' ? undefined : atSeq;
  }
  if (change.includeLaterToolOutputs === true) outputsUpToSeq = undefined;
  if (change.includeLaterToolOutputs === false) outputsUpToSeq = atSeq;
  return {
    ...(upToSeq !== undefined && { upToSeq }),
    ...(outputsUpToSeq !== undefined && { outputsUpToSeq }),
  };
}

/** `aiChat.sharing.live`. */
export type LiveShareLimits = {
  enabled: boolean;
  defaultHours: number;
  maxHours: number;
};

/** The values of `aiChat.sharing.live` that are left out (SH-11). */
export const DEFAULT_LIVE_SHARE_LIMITS: LiveShareLimits = {
  enabled: true,
  defaultHours: 24,
  maxHours: 72,
};

/**
 * When a live share made at `now` ends (SH-11): `hours` from now, or
 * `defaultHours` when not given. Throws `InvalidShare` when `hours` is not an
 * integer from 1 to `maxHours`.
 */
export function liveShareExpiry(
  now: Date,
  hours: number | undefined,
  limits: Pick<LiveShareLimits, 'defaultHours' | 'maxHours'>,
): string {
  const life = hours ?? limits.defaultHours;
  if (!Number.isInteger(life) || life < 1 || life > limits.maxHours) {
    throw new InvalidShare(
      `hours must be an integer from 1 to ${limits.maxHours}`,
    );
  }
  return new Date(now.getTime() + life * 3_600_000).toISOString();
}

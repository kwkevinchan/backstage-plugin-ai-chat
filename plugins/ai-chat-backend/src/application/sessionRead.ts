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

import type { Clock, Item, ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  NotSessionOwner,
  effectiveShare,
  isSessionOwner,
  shareGrantsRead,
  visibleItems,
  type Principal,
  type Session,
  type Share,
  type VisibleItem,
} from '../domain';
import type {
  AccessControl,
  SessionRepository,
  ShareRepository,
} from './ports';

/** Who reads a session: its owner, or someone a share names. */
export type SessionReader =
  | { session: Session; isOwner: true }
  | { session: Session; isOwner: false; shares: Share[] };

/**
 * The one check of every read of a session (SH-05): the permission
 * `ai-chat.session.read`, through `AccessControl`, with the shares of the
 * session. Throws `NotSessionOwner` when the principal may not read, the
 * same as for a session that does not exist.
 */
export async function authorizeRead(
  deps: {
    sessions: SessionRepository;
    shares: ShareRepository;
    access: AccessControl;
  },
  sessionId: string,
  principal: Principal,
): Promise<SessionReader> {
  const session = await deps.sessions.get(sessionId);
  const shares = await deps.shares.listBySession(session.id);
  const allowed = await deps.access.canReadSession({
    session,
    principal,
    shares,
  });
  if (!allowed) throw new NotSessionOwner(session.id);
  if (isSessionOwner(session, principal.userRef)) {
    return { session, isOwner: true };
  }
  return { session, isOwner: false, shares };
}

/** What a sharee sees of the log at one moment. */
export type ShareeView = {
  /** The union of the shares that name the principal and are not cancelled. */
  share: Share;
  /** The whole log, for rules that need what is hidden (never sent out). */
  all: Item[];
  /** The items the share shows, tool output past its bound reduced to a status. */
  visible: VisibleItem[];
};

/**
 * The items a sharee may see now: the shares that name the principal and
 * are not cancelled, joined into one, applied to the whole log. Throws
 * `NotSessionOwner` when none is left (a policy that allows without a share).
 */
export async function shareeView(
  deps: { items: ItemLog; clock: Clock },
  session: Pick<Session, 'id'>,
  principal: Principal,
  shares: readonly Share[],
): Promise<ShareeView> {
  const now = deps.clock.now().toISOString();
  const all = await deps.items.read(session.id);
  const share = effectiveShare(
    shares.filter(one => shareGrantsRead(one, principal)),
    all,
    now,
  );
  if (share === undefined) throw new NotSessionOwner(session.id);
  return {
    share,
    all,
    visible: visibleItems(all, { isOwner: false, share }, now),
  };
}

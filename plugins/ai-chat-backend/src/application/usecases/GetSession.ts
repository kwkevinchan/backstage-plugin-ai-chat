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

import {
  insertStatesOf,
  unreadInserted,
  type Clock,
  type Item,
  type ItemLog,
} from '@kwkevinchan/ai-chat-harness';
import {
  NotSessionOwner,
  callsAwaitingDecision,
  effectiveShare,
  isSessionOwner,
  shareGrantsRead,
  visibleItems,
  type Principal,
  type Run,
  type Session,
  type Share,
} from '../../domain';
import type {
  AccessControl,
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
  ShareRepository,
} from '../ports';
import { queueViewOf, type QueueView } from './ListQueue';

/** What a screen needs to show a session. */
export type SessionView = {
  session: Session;
  /** The run that has not ended, if there is one. */
  run?: Run;
  items: Item[];
  /**
   * The ids of the calls that wait for a decision of the user. Not limited to
   * `afterSeq`. Empty unless the run waits for an approval.
   */
  awaitingDecision: string[];
  /**
   * The run waits for an approval and no call is left to decide: the loop did
   * not start after the last decision. `ResumeRun` carries it on.
   */
  resumable: boolean;
  /** The queued messages and whether the queue waits for the user (IN-15). */
  queue: QueueView;
  /**
   * For each inserted message in `items`, by `seq`: `read`, `pending` (not
   * read yet, its run goes on) or `unread` (its run ended without reading it,
   * IN-12).
   */
  insertStates: ReadonlyMap<number, 'read' | 'pending' | 'unread'>;
};

/**
 * The session with its items and its active run (SE-01, SH-05). The owner
 * sees the same view as before. Someone a share names sees only `visibleItems`.
 * Anyone else gets `NotSessionOwner`.
 */
export class GetSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      queue: QueuedMessageRepository;
      shares: ShareRepository;
      access: AccessControl;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    sessionId: string;
    /** Only the items after this sequence number. */
    afterSeq?: number;
  }): Promise<SessionView> {
    const { runs, items } = this.deps;
    const session = await this.deps.sessions.get(input.sessionId);
    const shares = await this.deps.shares.listBySession(session.id);
    const allowed = await this.deps.access.canReadSession({
      session,
      principal: input.principal,
      shares,
    });
    if (!allowed) throw new NotSessionOwner(session.id);
    if (!isSessionOwner(session, input.principal.userRef)) {
      return this.forSharee(session, input.principal, shares, input.afterSeq);
    }
    const run = await runs.findActive(session.id);
    const list = await items.read(session.id, { afterSeq: input.afterSeq });
    let awaitingDecision: string[] = [];
    if (run?.status === 'waiting_approval') {
      // Whole log, whatever `afterSeq` says: a decision may be before it.
      const all = input.afterSeq ? await items.read(session.id) : list;
      awaitingDecision = callsAwaitingDecision(all, run.id).map(
        call => call.callId,
      );
    }
    return {
      session,
      ...(run && { run }),
      items: list,
      awaitingDecision,
      resumable:
        run?.status === 'waiting_approval' && awaitingDecision.length === 0,
      queue: await queueViewOf(this.deps, session.id),
      insertStates: await this.insertStates(
        session.id,
        list,
        run,
        input.afterSeq,
      ),
    };
  }

  private async insertStates(
    sessionId: string,
    list: Item[],
    run: Run | undefined,
    afterSeq?: number,
  ): Promise<ReadonlyMap<number, 'read' | 'pending' | 'unread'>> {
    const inserted = list.filter(
      item => item.kind === 'user_message' && item.delivery === 'inserted',
    );
    if (inserted.length === 0) return new Map();
    // A run is cut by its first message, which may be before `afterSeq`.
    const all = afterSeq ? await this.deps.items.read(sessionId) : list;
    const states = insertStatesOf(all);
    // While the run goes on, a message it did not read is not lost yet.
    const pending = new Set(
      run ? unreadInserted(all).map(item => item.seq) : [],
    );
    return new Map(
      inserted.map(item => [
        item.seq,
        pending.has(item.seq) ? 'pending' : states.get(item.seq) ?? 'unread',
      ]),
    );
  }

  /**
   * A sharee sees the run, and only the items the shares allow. The queue, the
   * decisions and resume are the owner's. Insert states come from the visible
   * items, so a hidden item cannot change them or leak through them.
   */
  private async forSharee(
    session: Session,
    principal: Principal,
    shares: readonly Share[],
    afterSeq?: number,
  ): Promise<SessionView> {
    const now = this.deps.clock.now().toISOString();
    const all = await this.deps.items.read(session.id);
    const share =
      effectiveShare(
        shares.filter(one => shareGrantsRead(one, principal)),
        all,
        now,
      ) ?? nothingShared(session.id, principal.userRef, now);
    const visible = visibleItems(all, { isOwner: false, share }, now);
    const list =
      afterSeq === undefined
        ? visible
        : visible.filter(item => item.seq > afterSeq);
    const run = await this.deps.runs.findActive(session.id);
    return {
      session,
      ...(run && { run }),
      items: list,
      awaitingDecision: [],
      resumable: false,
      queue: { items: [], paused: false },
      insertStates: statesOf(list, visible, run),
    };
  }
}

/**
 * No granting share. Seq 0 shows no item (sequence numbers start at 1) and an
 * output bound of 0 would hide every tool output if one were in range.
 */
function nothingShared(
  sessionId: string,
  subjectRef: string,
  now: string,
): Share {
  return {
    id: 'none',
    sessionId,
    subjectRef,
    createdBy: subjectRef,
    createdAt: now,
    upToSeq: 0,
    outputsUpToSeq: 0,
  };
}

function statesOf(
  list: Item[],
  source: readonly Item[],
  run: Run | undefined,
): ReadonlyMap<number, 'read' | 'pending' | 'unread'> {
  const inserted = list.filter(
    item => item.kind === 'user_message' && item.delivery === 'inserted',
  );
  if (inserted.length === 0) return new Map();
  const states = insertStatesOf(source);
  const pending = new Set(
    run ? unreadInserted(source).map(item => item.seq) : [],
  );
  return new Map(
    inserted.map(item => [
      item.seq,
      pending.has(item.seq) ? 'pending' : states.get(item.seq) ?? 'unread',
    ]),
  );
}

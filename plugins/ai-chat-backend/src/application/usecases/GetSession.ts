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
  type Item,
  type ItemLog,
} from '@kwkevinchan/ai-chat-harness';
import {
  assertOwner,
  callsAwaitingDecision,
  type Principal,
  type Run,
  type Session,
} from '../../domain';
import type {
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
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

/** The session with its items and its active run, for the owner (SE-01). */
export class GetSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      queue: QueuedMessageRepository;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    sessionId: string;
    /** Only the items after this sequence number. */
    afterSeq?: number;
  }): Promise<SessionView> {
    const { sessions, runs, items } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
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
}

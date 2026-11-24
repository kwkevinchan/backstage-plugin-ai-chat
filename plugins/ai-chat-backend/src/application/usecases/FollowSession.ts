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

import type { HarnessEvent, Item, ItemLog } from '@kwkevinchan/ai-chat-harness';
import { assertOwner, type Principal, type Run } from '../../domain';
import type { RunSupervisor } from '../RunSupervisor';
import type { RunRepository, SessionRepository } from '../ports';

/**
 * What a client that joins a run needs: the items of the run so far, and the
 * events from then on. Read `events` to the end, or call `return()` on its
 * iterator, so the subscription goes away.
 */
export type FollowHandle = {
  run: Run;
  /** The items of the run, from its first one, in the order of `seq`. */
  items: Item[];
  /**
   * The highest `seq` the log had when it was read, also when `afterSeq` left
   * the items out. Events of items up to it are replays.
   */
  upToSeq: number;
  events: AsyncIterable<HarnessEvent>;
};

/**
 * A client joins the run that is under way, for example after a reload (A-07):
 * it gets the run from its first item, then what comes next. Only a run that
 * is `running` has anything to follow; one that waits for an approval has no
 * loop, and one that ended is in the log.
 */
export class FollowSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      supervisor: RunSupervisor;
    },
  ) {}

  /**
   * Returns `undefined` when there is nothing to follow: no run, a run that
   * does not run, or a run that another backend runs (following a run across
   * backends is not there yet). Throws `NotSessionOwner`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    /** Leaves out the items up to this `seq`. */
    afterSeq?: number;
  }): Promise<FollowHandle | undefined> {
    const { sessions, runs, items, supervisor } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const run = await runs.findActive(session.id);
    if (!run || run.status !== 'running') return undefined;

    // Subscribe before reading: an item that is written in between is in the
    // log and in the events, and the presenter skips it the second time.
    const events = supervisor.subscribe(run.id);
    if (!events) return undefined;
    try {
      const log = (await items.read(session.id)).filter(
        item => item.runId === run.id,
      );
      const afterSeq = input.afterSeq ?? 0;
      return {
        run,
        items: log.filter(item => item.seq > afterSeq),
        upToSeq: log.reduce((max, item) => Math.max(max, item.seq), 0),
        events,
      };
    } catch (error) {
      await events[Symbol.asyncIterator]().return?.();
      throw error;
    }
  }
}

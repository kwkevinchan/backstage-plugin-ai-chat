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

import { abortableSleep } from '../sleep';
import type {
  Clock,
  Item,
  ItemLog,
  RunOutcome,
  StopReason,
} from '@kwkevinchan/ai-chat-harness';
import {
  NotSessionOwner,
  callsAwaitingDecision,
  type Principal,
  type Run,
  type Session,
  type Share,
} from '../../domain';
import type { HostEvent } from '../hostEvents';
import type { RunSupervisor } from '../RunSupervisor';
import type {
  AccessControl,
  Logger,
  RunRepository,
  SessionRepository,
  ShareRepository,
} from '../ports';
import { authorizeRead, shareeView } from '../sessionRead';

/** How often a run on another backend is read. The spec says one second. */
const DEFAULT_POLL_MS = 1000;
/** Stop polling after this many consecutive read failures. */
const MAX_POLL_ERRORS = 3;

const STOP_REASONS: readonly StopReason[] = [
  'max_steps',
  'max_tool_calls',
  'timeout',
];

/**
 * What a client that joins a run needs: the items of the run so far, and the
 * events from then on. Read `events` to the end, or call `return()` on its
 * iterator, so the subscription or the poll goes away. The run keeps going.
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
  /**
   * The messages inserted into the run that the stream must still show, whatever
   * `afterSeq` leaves out: the ones that no output up to `afterSeq` read. The
   * presenter sends each before the output that read it.
   */
  inserted: Item[];
  /**
   * Text of an agent message that was open on this backend when the client
   * subscribed, and that the log does not contain yet. Absent when the item
   * completed while the log was read, and when the run is on another backend
   * (that text is sent whole once the item is stored).
   */
  resumeText?: { draftId: string; text: string };
  events: AsyncIterable<HostEvent>;
};

/**
 * A client joins the run that is under way, for example after a reload (A-07):
 * it gets the run from its first item, then what comes next.
 *
 * - The run is `running` on this backend: subscribe first, then read the log.
 *   `resumeText` is the draft at subscribe time.
 * - The run is `running` on another backend: replay the stored items, then
 *   read the log once a second. Only completed items are sent. When the run
 *   leaves `running`, the same end as this backend is sent, and the poll stops.
 * - No run, a run that ended, or a run that waits for an approval: nothing to
 *   follow. A stream kept open on a run that waits would leave `useChat` in
 *   `streaming`, and an approval would not be sent.
 */
export class FollowSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      supervisor: RunSupervisor;
      shares: ShareRepository;
      access: AccessControl;
      clock: Clock;
      logger?: Logger;
      /** Waits between reads of a run on another backend. One second by default. */
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      /** The wait. One second by default, so a test does not really wait. */
      pollIntervalMs?: number;
    },
  ) {}

  /**
   * Returns `undefined` when there is nothing to follow: no run, or a run that
   * is not `running`. Throws `NotSessionOwner`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    /** Leaves out the items up to this `seq`. */
    afterSeq?: number;
  }): Promise<FollowHandle | undefined> {
    const { runs, supervisor } = this.deps;
    const reader = await authorizeRead(
      this.deps,
      input.sessionId,
      input.principal,
    );
    const { session } = reader;
    if (!reader.isOwner) {
      return this.followAsSharee(
        session,
        input.principal,
        reader.shares,
        input.afterSeq,
      );
    }
    const run = await runs.findActive(session.id);
    if (!run || run.status !== 'running') return undefined;

    // Subscribe before reading: an item that is written in between is in the
    // log and in the events, and the presenter skips it the second time.
    // The draft is taken in this turn, before the read, so a delta that is
    // only queued for this subscriber is not part of the prefix.
    const events = supervisor.subscribe(run.id);
    if (events) {
      const draft = supervisor.openDraft?.(run.id);
      try {
        const log = await this.logOf(session.id, run.id);
        const resumeText = prefixOf(draft, bufferedOf(events), log);
        return {
          ...viewOf(log, input.afterSeq ?? 0),
          run,
          events,
          ...(resumeText && { resumeText }),
        };
      } catch (error) {
        await events[Symbol.asyncIterator]().return?.();
        throw error;
      }
    }

    const log = await this.logOf(session.id, run.id);
    const view = viewOf(log, input.afterSeq ?? 0);
    return {
      ...view,
      run,
      events: this.remoteEvents(session.id, run.id, view.upToSeq),
    };
  }

  /**
   * A sharee follows only a share that keeps updating and has not expired: a
   * snapshot does not move. The sharee always gets the poll, even when the
   * loop is on this backend, because the events of the loop carry tool
   * output and text fragments the share may not show. Each read takes the
   * shares again and reads the log after the cursor only (the whole log
   * when a share is past its expiry), so a cancel or an expiry ends the stream within one
   * interval; the policy and the groups are checked once, at the start.
   */
  private async followAsSharee(
    session: Session,
    principal: Principal,
    shares: readonly Share[],
    afterSeq?: number,
  ): Promise<FollowHandle | undefined> {
    const first = await shareeView(this.deps, session, principal, shares);
    if (first.share.upToSeq !== undefined) return undefined;
    const run = await this.deps.runs.findActive(session.id);
    if (!run || run.status !== 'running') return undefined;
    const view = viewOf(
      first.visible.filter(item => item.runId === run.id),
      afterSeq ?? 0,
    );
    const read: PollRead = async (current, cursor) => {
      const now = await this.deps.shares.listBySession(session.id);
      let seen;
      try {
        seen = await shareeView(this.deps, session, principal, now, {
          afterSeq: cursor,
        });
      } catch (error) {
        if (error instanceof NotSessionOwner) return undefined;
        throw error;
      }
      if (seen.share.upToSeq !== undefined) return undefined;
      return {
        log: seen.visible.filter(
          item => item.runId === current.id && item.seq > cursor,
        ),
        // The decisions are the owner's: no call to approve is sent.
        fullLog: [],
      };
    };
    return {
      ...view,
      run,
      events: this.remoteEvents(session.id, run.id, view.upToSeq, read),
    };
  }

  private logOf(
    sessionId: string,
    runId: string,
    afterSeq?: number,
  ): Promise<Item[]> {
    return this.deps.items
      .read(sessionId, afterSeq !== undefined ? { afterSeq } : undefined)
      .then(log => log.filter(item => item.runId === runId));
  }

  /**
   * The events of a run this process does not run: completed items only, one
   * read per interval, then the end stored for the run. `return()` stops the
   * poll and does not read again. The run is left running (A-06). No
   * `queue.state`: the queue is told by the backend that runs the loop.
   */
  private remoteEvents(
    sessionId: string,
    runId: string,
    fromSeq: number,
    read: PollRead = async (current, cursor) => {
      if (current.status === 'waiting_approval') {
        const fullLog = await this.logOf(sessionId, current.id);
        return { log: fullLog, fullLog };
      }
      return {
        log: await this.logOf(sessionId, current.id, cursor),
        fullLog: [],
      };
    },
  ): AsyncIterable<HostEvent> {
    const interval = this.deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    const sleep = this.deps.sleep ?? abortableSleep;
    const abort = new AbortController();
    let cursor = fromSeq;
    let stopped = false;
    let pollErrors = 0;
    const waiting: Item[] = [];

    return {
      [Symbol.asyncIterator]: () => {
        const pending: HostEvent[] = [];
        return {
          next: async (): Promise<IteratorResult<HostEvent>> => {
            for (;;) {
              if (pending.length > 0) {
                return { value: pending.shift() as HostEvent, done: false };
              }
              if (stopped || abort.signal.aborted) {
                return { value: undefined, done: true };
              }
              await sleep(interval, abort.signal);
              if (stopped || abort.signal.aborted) {
                return { value: undefined, done: true };
              }
              let run: Run;
              let log: Item[];
              let fullLog: Item[];
              try {
                run = await this.deps.runs.get(runId);
                const got = await read(run, cursor);
                if (got === undefined) {
                  // The reader may not see the run any more.
                  stopped = true;
                  continue;
                }
                ({ log, fullLog } = got);
                pollErrors = 0;
              } catch (error) {
                pollErrors += 1;
                if (pollErrors >= MAX_POLL_ERRORS) throw error;
                this.deps.logger?.warn(
                  'Could not poll a run on another backend',
                  {
                    runId,
                    attempt: pollErrors,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
                continue;
              }
              const after = cursor;
              const fresh = log
                .filter(item => item.seq > after)
                .sort((a, b) => a.seq - b.seq);
              for (const item of fresh) {
                cursor = item.seq;
                if (
                  item.kind === 'user_message' &&
                  item.delivery === 'inserted'
                ) {
                  waiting.push(item);
                }
                if (
                  item.kind === 'agent_message' ||
                  item.kind === 'tool_call'
                ) {
                  const mark = item.readUpToSeq ?? item.seq;
                  for (const message of waiting.filter(m => m.seq <= mark)) {
                    pending.push({ type: 'message.read', item: message });
                  }
                  for (let i = waiting.length - 1; i >= 0; i -= 1) {
                    if (waiting[i].seq <= mark) waiting.splice(i, 1);
                  }
                }
                pending.push({ type: 'item.completed', item });
              }
              if (run.status !== 'running') {
                pending.push({
                  type: 'run.ended',
                  outcome: outcomeOfStoredRun(run, fullLog),
                });
                stopped = true;
              }
            }
          },
          return: async () => {
            stopped = true;
            abort.abort();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

/**
 * One read of a poll: the items of the run after `cursor` and, while the run
 * waits for an approval, the log that names the calls to decide. `undefined`
 * when the reader may no longer see the run, which ends the stream.
 */
type PollRead = (
  run: Run,
  cursor: number,
) => Promise<{ log: Item[]; fullLog: Item[] } | undefined>;

function viewOf(log: Item[], afterSeq: number) {
  return {
    inserted: log.filter(
      item =>
        item.kind === 'user_message' &&
        item.delivery === 'inserted' &&
        !log.some(
          output =>
            (output.kind === 'agent_message' || output.kind === 'tool_call') &&
            output.seq <= afterSeq &&
            (output.readUpToSeq ?? output.seq) >= item.seq,
        ),
    ),
    items: log.filter(item => item.seq > afterSeq),
    upToSeq: log.reduce((max, item) => Math.max(max, item.seq), 0),
  };
}

/**
 * The prefix to send, or nothing when the item already completed in the
 * events that are queued: the replay or that completion sends the whole text.
 * Deltas that are only queued are not added; the live stream sends them.
 */
function prefixOf(
  draft: { draftId: string; text: string; emittedSeq?: number } | undefined,
  buffered: readonly HostEvent[],
  log: readonly Item[],
): { draftId: string; text: string } | undefined {
  if (!draft) return undefined;
  const completedInEvents = buffered.some(
    event => event.type === 'item.completed' && event.draftId === draft.draftId,
  );
  const completedInLog =
    draft.emittedSeq !== undefined &&
    log.some(
      item => item.kind === 'agent_message' && item.seq > draft.emittedSeq!,
    );
  return completedInEvents || completedInLog
    ? undefined
    : { draftId: draft.draftId, text: draft.text };
}

function bufferedOf(events: AsyncIterable<HostEvent>): HostEvent[] {
  const buffered = (events as { buffered?: () => HostEvent[] }).buffered;
  return typeof buffered === 'function' ? buffered.call(events) : [];
}

/** What the presenter already sends when a run on this backend ends. */
function outcomeOfStoredRun(run: Run, log: readonly Item[]): RunOutcome {
  switch (run.status) {
    case 'completed': {
      const endReason = STOP_REASONS.find(reason => reason === run.endReason);
      return endReason
        ? { status: 'completed', endReason }
        : { status: 'completed' };
    }
    case 'waiting_approval':
      return {
        status: 'waiting_approval',
        pending: callsAwaitingDecision(log, run.id),
      };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'failed':
    case 'expired':
      return { status: 'failed', message: 'The run stopped.' };
    default:
      return { status: 'failed', message: 'The run stopped.' };
  }
}

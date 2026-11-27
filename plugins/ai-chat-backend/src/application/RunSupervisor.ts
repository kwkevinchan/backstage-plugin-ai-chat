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
  LeaseLost,
  InvalidRunTransition,
  type AdvanceRun,
  type AdvanceRunRequest,
  type HarnessEvent,
  type RunFence,
  type RunOutcome,
} from '@kwkevinchan/ai-chat-harness';
import {
  ShuttingDown,
  UnreadMessages,
  isNormalEnd,
  type LeasedRun,
  type Principal,
  type Run,
} from '../domain';
import { EventChannel } from './EventChannel';
import { errorLogFields } from './modelErrors';
import { notifyActivity, type ActivityNotifier } from './notifyActivity';
import type { AfterRun, HostEvent } from './hostEvents';
import { RUN_END_HOOK_TIMEOUT_MS, type RunEnded } from './runEnded';
import type {
  Logger,
  RunRepository,
  RunTransitionTarget,
  SessionActivity,
} from './ports';

/** What `launch` needs besides the run: the request of the loop without what the supervisor adds. */
export type LaunchRequest = Omit<AdvanceRunRequest, 'fence' | 'signal'>;

/**
 * A run that is going on in this process. `events` is the first subscriber:
 * it gets every event of the run from the start. Read it to the end or call
 * `return()` on its iterator (`break` in a `for await` does); an unread
 * subscriber keeps its events in memory until the run ends. `done` settles
 * when the loop has ended and the run is up to date.
 */
export type RunHandle = {
  runId: string;
  events: AsyncIterable<HostEvent>;
  done: Promise<void>;
};

export type RunSupervisorDeps = {
  advance: Pick<AdvanceRun, 'execute'>;
  runs: RunRepository;
  logger: Logger;
  /**
   * Runs once the status of a run is written and tells the state of the queue
   * (IN-14). A run that waits for an approval is reported too.
   */
  afterRun?: AfterRun;
  /**
   * Writes a title after a normal end, once the queue has been reported,
   * `run.ended` has been published and the subscribers have been ended
   * (SE-04). Still runs inside the loop, so `shutdown` waits for it. A
   * failure is logged and does not change the run.
   */
  nameSession?: (info: {
    run: Run;
    outcome: RunOutcome;
    signal: AbortSignal;
  }) => Promise<void>;
  /**
   * Tells the `onRunEnd` hooks, each time this supervisor wrote the end of a
   * run: after a status change with the fence, a failure of a port, a stop
   * that came after the wait for an approval was written, or the shutdown.
   */
  runEnded?: RunEnded;
  /** How often the lease is renewed while a model call takes long. 10 seconds by default. */
  heartbeatMs?: number;
  /**
   * Tells the owner that the activity of the session changed (B-05). A failure
   * is logged and does not fail the run. Unset in tests that do not care.
   */
  notify?: ActivityNotifier;
};

type Loop = {
  run: LeasedRun;
  request: LaunchRequest;
  controller: AbortController;
  subscribers: Set<EventChannel<HostEvent>>;
  /** Set when `run.ended` went to the subscribers: a new subscriber would not get it. */
  ended: boolean;
  /** Set when the shutdown takes the run over; the loop then leaves its status alone. */
  shuttingDown: boolean;
  done: Promise<void>;
  /** The agent text that is open, so a client that joins can be given it. */
  draft?: { draftId: string; text: string };
  /** Highest item `seq` published as `item.completed` in this loop (or before resume). */
  emittedSeq: number;
};

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_GRACE_MS = 20_000;
const ABORT_WAIT_MS = 2_000;
/**
 * How often one loop starts again because a message came in after the model
 * read the log. Every round reads at least one more inserted message, and a
 * run takes at most 20 (`input.insert.maxPerRun` is capped at 20), so a loop
 * that needs more rounds makes no progress.
 */
const MAX_REREADS = 20;

/**
 * The runs of this backend (D-16, H-04, H-07, H-11).
 *
 * - `launch` starts the loop of a run that the caller holds the lease of and
 *   reads its events in the background. A subscriber that goes away does not
 *   stop the run (A-06): the loop does not depend on any reader.
 * - It renews the lease with a timer too, so a model call that takes long
 *   does not lose it, and it stops the loop when the lease is lost or the user
 *   asked to stop.
 * - It writes the status of the run before it tells the subscribers that the
 *   run ended, so a client that answers the end of the stream finds the run in
 *   the new status. A port that throws (such as `LeaseLost`) ends the loop
 *   without `run.ended`; the supervisor then ends the run itself, or leaves it
 *   to whoever holds the lease now.
 * - A run does not end while a message that was inserted into it is unread
 *   (IN-11): when the status change is refused (`UnreadMessages`), the
 *   supervisor drops that `run.ended` and the next `run.started`, and runs
 *   the loop again on the same lease, so the subscribers see one run.
 * - After the status of a run is written, `afterRun` tells the state of the
 *   queue (it may start the next run). The subscribers get it as
 *   `queue.state`, before `run.ended`.
 * - On a normal end, after the queue, `run.ended` is published and the
 *   subscribers are ended, then `nameSession` may write a title (SE-04).
 *   That still happens inside the loop, so `shutdown` waits for it. A
 *   failure is logged; the run stays as it was written.
 * - `fences` has the fence of every run this process is running. A run that is
 *   carried on after an approval has a new fence, and replaces the old one;
 *   the entry goes when the loop ends, also on an error.
 * - `shutdown` takes no new runs, waits for the running ones, then stops the
 *   rest and marks each `expired` with the fence it holds, never without it:
 *   a run another backend took over is not ours to end.
 *
 * The loop keeps the process alive (it awaits I/O of its own); the deadline
 * timer of the loop is `unref`ed, so this class runs every loop until its
 * generator ends.
 */
export class RunSupervisor {
  private readonly fences = new Map<string, RunFence>();
  private readonly loops = new Map<string, Loop>();
  private closed = false;

  constructor(private readonly deps: RunSupervisorDeps) {}

  /** Whether this supervisor takes new runs; false once `shutdown` began. */
  get accepting(): boolean {
    return !this.closed;
  }

  /**
   * Starts the loop of `run`, which the caller holds the lease of. Throws
   * `ShuttingDown` after `shutdown` began; the caller still holds the lease
   * then and must end the run.
   */
  launch(
    run: LeasedRun,
    request: LaunchRequest,
    opts?: { initialSeq?: number },
  ): RunHandle {
    if (this.closed) throw new ShuttingDown();
    const loop: Loop = {
      run,
      request,
      controller: new AbortController(),
      subscribers: new Set(),
      ended: false,
      shuttingDown: false,
      done: Promise.resolve(),
      emittedSeq: opts?.initialSeq ?? 0,
    };
    const events = this.addSubscriber(loop);
    this.fences.set(run.id, run.fence);
    this.loops.set(run.fence.leaseOwner, loop);
    loop.done = this.runLoop(loop);
    this.tell(loop, 'running');
    return { runId: run.id, events, done: loop.done };
  }

  /**
   * A new subscriber of a run that this process runs; it gets the events from
   * now on. `undefined` when the run is not running here, and when its
   * `run.ended` went out already: the new subscriber would never get it.
   */
  subscribe(runId: string): EventChannel<HostEvent> | undefined {
    const loop = this.loopOf(runId);
    return loop && !loop.ended ? this.addSubscriber(loop) : undefined;
  }

  /**
   * The text of the agent message that is open, at this moment. A client that
   * joins calls it in the same turn as `subscribe`, before it reads the log,
   * so the text does not include deltas that are only queued for that
   * subscriber. `undefined` when this process does not run the run, or no
   * agent message is open.
   */
  openDraft(
    runId: string,
  ): { draftId: string; text: string; emittedSeq: number } | undefined {
    const loop = this.loopOf(runId);
    if (!loop || loop.ended || !loop.draft) return undefined;
    return {
      draftId: loop.draft.draftId,
      text: loop.draft.text,
      emittedSeq: loop.emittedSeq,
    };
  }

  /** Stops the loop of the run if this process runs it. Returns whether it did. */
  cancel(runId: string): boolean {
    const fence = this.fences.get(runId);
    const loop = fence && this.loops.get(fence.leaseOwner);
    if (!loop) return false;
    loop.controller.abort();
    return true;
  }

  /** The ids of the runs this process runs. */
  activeRunIds(): string[] {
    return [...this.fences.keys()];
  }

  /**
   * H-11. Takes no new runs, waits up to `graceMs` for the running ones, then
   * aborts what is left and marks each of those runs `expired`. Last, it waits
   * up to `RUN_END_HOOK_TIMEOUT_MS` (10 seconds) for the `onRunEnd` hooks
   * that still run.
   */
  async shutdown(graceMs: number = DEFAULT_GRACE_MS): Promise<void> {
    this.closed = true;
    await this.settled(graceMs);
    for (const [runId, fence] of [...this.fences]) {
      const loop = this.loops.get(fence.leaseOwner);
      if (loop) {
        loop.shuttingDown = true;
        loop.controller.abort();
      }
      try {
        const run = await this.deps.runs.transition(runId, 'expired', {
          leaseOwner: fence.leaseOwner,
          endReason: 'shutdown',
        });
        if (loop) {
          this.tell(loop, 'idle');
          this.runEnded(loop, run);
        }
      } catch (error) {
        if (!(error instanceof LeaseLost || isInvalidTransition(error))) {
          this.deps.logger.error('Could not mark a run expired at shutdown', {
            runId,
            error: error instanceof Error ? error : String(error),
          });
        }
      }
    }
    await this.settled(ABORT_WAIT_MS);
    await this.deps.runEnded?.drain(RUN_END_HOOK_TIMEOUT_MS);
  }

  private async settled(ms: number): Promise<void> {
    const all = [...this.loops.values()].map(loop => loop.done);
    if (all.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([Promise.allSettled(all), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private addSubscriber(loop: Loop): EventChannel<HostEvent> {
    const channel: EventChannel<HostEvent> = new EventChannel(() =>
      loop.subscribers.delete(channel),
    );
    loop.subscribers.add(channel);
    return channel;
  }

  private loopOf(runId: string): Loop | undefined {
    const fence = this.fences.get(runId);
    return fence ? this.loops.get(fence.leaseOwner) : undefined;
  }

  private publish(loop: Loop, event: HostEvent): void {
    if (event.type === 'run.ended') loop.ended = true;
    if (event.type === 'item.completed') {
      loop.emittedSeq = Math.max(loop.emittedSeq, event.item.seq);
    }
    this.noteDraft(loop, event);
    for (const subscriber of loop.subscribers) subscriber.push(event);
  }

  /** The open agent text, so a client that joins in the middle can show it. */
  private noteDraft(loop: Loop, event: HostEvent): void {
    if (event.type === 'item.started' && event.kind === 'agent_message') {
      loop.draft = { draftId: event.draftId, text: '' };
      return;
    }
    if (event.type === 'item.delta' && loop.draft?.draftId === event.draftId) {
      loop.draft = {
        draftId: event.draftId,
        text: loop.draft.text + event.text,
      };
      return;
    }
    if (
      event.type === 'item.completed' &&
      loop.draft &&
      event.draftId === loop.draft.draftId
    ) {
      loop.draft = undefined;
    }
  }

  /**
   * Tells the owner. A failure is logged: the run has its own result and is
   * not affected.
   */
  private tell(loop: Loop, activity: SessionActivity): void {
    notifyActivity(
      this.deps.notify,
      this.deps.logger,
      loop.run.sessionId,
      activity,
    );
  }

  /**
   * Tells the hooks about a run this supervisor ended; `run` is what the
   * status change returned. A run that waits for an approval is ignored.
   */
  private runEnded(loop: Loop, run: Run): void {
    this.deps.runEnded?.({
      run,
      agentId: loop.request.agent.id,
      // `buildRunRequest` puts the principal of the request into the context.
      userRef: (loop.request.ctx.principal as Principal).userRef,
    });
  }

  private endSubscribers(loop: Loop): void {
    for (const subscriber of loop.subscribers) subscriber.end();
    loop.subscribers.clear();
  }

  private async runLoop(loop: Loop): Promise<void> {
    const { run } = loop;
    const timer = setInterval(
      () => void this.renew(loop),
      this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
    let generator = this.deps.advance.execute({
      ...loop.request,
      fence: run.fence,
      signal: loop.controller.signal,
    });
    let ended = false;
    let rereads = 0;
    try {
      for (;;) {
        const next = await generator.next();
        if (next.done) break;
        let event: HarnessEvent = next.value;
        // The run began already: the second round of the loop is no new run.
        if (event.type === 'run.started' && rereads > 0) continue;
        if (event.type === 'run.ended') {
          const settled = await this.settle(loop, event.outcome);
          if (settled === 'unread') {
            if (++rereads > MAX_REREADS) {
              throw new Error('The run kept finding messages it had not read');
            }
            await generator.return(undefined as never).catch(() => undefined);
            generator = await this.again(loop);
            continue;
          }
          ended = true;
          if (settled.outcome !== event.outcome) {
            event = { ...event, outcome: settled.outcome };
          }
          await this.reportQueue(loop, settled);
          this.publish(loop, forSubscribers(event));
          this.endSubscribers(loop);
          await this.nameSession(loop, settled);
          continue;
        }
        if (event.type === 'summary.failed') {
          // Only the name and the status of the error: the message of the
          // model server may carry what the user or a tool wrote.
          this.deps.logger.warn('A summary could not be made', {
            runId: run.id,
            ...(event.cause !== undefined && errorLogFields(event.cause)),
          });
        }
        this.publish(loop, forSubscribers(event));
      }
    } catch (error) {
      if (!ended) await this.settleError(loop, error);
    } finally {
      clearInterval(timer);
      await generator.return(undefined as never).catch(() => undefined);
      if (this.fences.get(run.id) === run.fence) this.fences.delete(run.id);
      this.loops.delete(run.fence.leaseOwner);
      this.endSubscribers(loop);
    }
  }

  /** The loop again, on the same lease, with the usage the run has now. */
  private async again(loop: Loop) {
    const { usage } = await this.deps.runs.get(loop.run.id);
    return this.deps.advance.execute({
      ...loop.request,
      usage,
      fence: loop.run.fence,
      signal: loop.controller.signal,
    });
  }

  /**
   * Asks `afterRun` for the state of the queue and sends it to the
   * subscribers. A run this backend does not own any more (`run` is
   * undefined) has nothing to report. A failure is logged: the run has ended
   * and is not affected.
   */
  private async reportQueue(
    loop: Loop,
    settled: { run?: Run; outcome: RunOutcome },
  ): Promise<void> {
    if (!settled.run || !this.deps.afterRun) return;
    try {
      const state = await this.deps.afterRun({
        run: settled.run,
        outcome: settled.outcome,
        // `buildRunRequest` puts the principal of the request into the context.
        principal: loop.request.ctx.principal as Principal,
      });
      this.publish(loop, { type: 'queue.state', ...state });
    } catch (error) {
      this.deps.logger.error('Could not tell the state of the queue', {
        runId: loop.run.id,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /**
   * Asks for a title after a normal end. The status is already written and
   * `run.ended` has already gone to the subscribers, so a failure here is
   * only a log line.
   */
  private async nameSession(
    loop: Loop,
    settled: { run?: Run; outcome: RunOutcome },
  ): Promise<void> {
    if (!this.deps.nameSession || !settled.run) return;
    if (!isNormalEnd(settled.outcome)) return;
    try {
      await this.deps.nameSession({
        run: settled.run,
        outcome: settled.outcome,
        signal: loop.controller.signal,
      });
    } catch (error) {
      this.deps.logger.error('Could not name the session', {
        runId: loop.run.id,
        ...errorLogFields(error),
      });
    }
  }

  /** Renews the lease between the rounds of the loop; stops the loop when it must stop. */
  private async renew(loop: Loop): Promise<void> {
    try {
      const { cancelRequested } = await this.deps.runs.heartbeat(
        loop.run.fence,
      );
      if (cancelRequested) loop.controller.abort();
    } catch (error) {
      if (error instanceof LeaseLost) {
        loop.controller.abort();
        return;
      }
      // A failed attempt (the database is slow, say) is not a lost lease: the
      // lease lasts longer than one interval, and the loop renews it too.
      this.deps.logger.warn('Could not renew the lease of a run', {
        runId: loop.run.id,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /**
   * Writes the status the outcome gives the run. Returns the outcome the
   * subscribers get (the same one, except when a stop request turns a wait for
   * an approval into `cancelled`) and the run as it is stored, or `undefined`
   * for the run when it is not ours any more. Returns `'unread'` when the run
   * cannot end: a message was inserted that the model did not read.
   */
  private async settle(
    loop: Loop,
    outcome: RunOutcome,
  ): Promise<{ run?: Run; outcome: RunOutcome } | 'unread'> {
    if (loop.shuttingDown) return { outcome };
    if (outcome.status === 'failed') {
      // Only the name and the status of the error: the message of the model
      // server may carry what the user or a tool wrote.
      this.deps.logger.error('A run failed', {
        runId: loop.run.id,
        ...(outcome.cause !== undefined && errorLogFields(outcome.cause)),
      });
    }
    const [to, endReason] = statusOf(outcome);
    let run: Run | undefined;
    try {
      run = await this.end(loop, to, endReason, {
        // Only an answer of the model ends a run by itself; a limit or a stop
        // leaves the messages unread, and the screen says so (IN-12).
        requireAllRead: to === 'completed' && endReason === undefined,
      });
    } catch (error) {
      if (error instanceof UnreadMessages) return 'unread';
      throw error;
    }
    // A stop request that was stored after the last heartbeat of the loop:
    // the loop did not see it, and the run must not wait for an approval that
    // the user no longer wants.
    if (to === 'waiting_approval' && run?.cancelRequested) {
      const cancelled = await this.end(loop, 'cancelled', 'user', {
        withLease: false,
      });
      // The subscribers must not show approval buttons of a cancelled run.
      if (cancelled) {
        this.tell(loop, 'idle');
        this.runEnded(loop, cancelled);
      }
      return { run: cancelled, outcome: { status: 'cancelled' } };
    }
    if (run) {
      this.tell(loop, activityOf(outcome));
      this.runEnded(loop, run);
    }
    return { run, outcome };
  }

  /** The loop ended with an error of a port, so there is no `run.ended` yet. */
  private async settleError(loop: Loop, error: unknown): Promise<void> {
    const lost = error instanceof LeaseLost;
    if (!lost) {
      this.deps.logger.error('A run stopped with an error', {
        runId: loop.run.id,
        error: error instanceof Error ? error : String(error),
      });
    }
    if (!loop.shuttingDown && !lost) {
      try {
        const run = await this.end(loop, 'failed', 'error');
        if (run) this.runEnded(loop, run);
        await this.reportQueue(loop, {
          run,
          outcome: { status: 'failed', message: 'The run stopped.' },
        });
      } catch (inner) {
        this.deps.logger.error('Could not mark a run failed', {
          runId: loop.run.id,
          error: inner instanceof Error ? inner : String(inner),
        });
      }
    }
    this.publish(loop, {
      type: 'run.ended',
      outcome: { status: 'failed', message: 'The run stopped.' },
    });
    // The shutdown tells `idle` itself. A lost lease is someone else's run.
    if (!loop.shuttingDown && !lost) this.tell(loop, 'idle');
  }

  /**
   * Changes the status of the run. `withLease` is false once the loop gave up
   * the lease (a run that waits for an approval has none). Returns the run, or
   * `undefined` when it is not ours any more. With `requireAllRead` it throws
   * `UnreadMessages` when the run has a message that was not read.
   */
  private async end(
    loop: Loop,
    to: RunTransitionTarget,
    endReason?: string,
    opts: { withLease?: boolean; requireAllRead?: boolean } = {},
  ): Promise<Run | undefined> {
    try {
      return await this.deps.runs.transition(loop.run.id, to, {
        ...(opts.withLease !== false && {
          leaseOwner: loop.run.fence.leaseOwner,
        }),
        ...(endReason !== undefined && { endReason }),
        ...(opts.requireAllRead && { requireAllRead: true }),
      });
    } catch (error) {
      // Someone else holds or has ended the run: its status is not ours.
      if (!(error instanceof LeaseLost || isInvalidTransition(error))) {
        throw error;
      }
      return undefined;
    }
  }
}

/**
 * What the subscribers get: the original error of a failure or of a failed
 * summary stays out (it can hold text of the provider); the log has it.
 */
function forSubscribers(event: HarnessEvent): HarnessEvent {
  if (event.type === 'summary.failed') return { type: 'summary.failed' };
  if (event.type === 'run.ended' && event.outcome.status === 'failed') {
    return {
      type: 'run.ended',
      outcome: { status: 'failed', message: event.outcome.message },
    };
  }
  return event;
}

function activityOf(outcome: RunOutcome): SessionActivity {
  switch (outcome.status) {
    case 'completed':
      return 'replied';
    case 'waiting_approval':
      return 'waiting_approval';
    case 'cancelled':
    case 'failed':
      return 'idle';
    default:
      return outcome satisfies never;
  }
}

function statusOf(outcome: RunOutcome): [RunTransitionTarget, string?] {
  switch (outcome.status) {
    case 'completed':
      return ['completed', outcome.endReason];
    case 'waiting_approval':
      return ['waiting_approval'];
    case 'cancelled':
      return ['cancelled', 'user'];
    case 'failed':
      return ['failed', 'error'];
    default:
      return outcome satisfies never;
  }
}

function isInvalidTransition(error: unknown): boolean {
  return error instanceof InvalidRunTransition;
}

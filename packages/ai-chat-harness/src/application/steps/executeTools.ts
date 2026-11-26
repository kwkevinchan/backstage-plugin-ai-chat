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
  decisionOf,
  needsApproval,
  type Item,
  type ToolCallItem,
  type ToolResultBody,
} from '../../domain';
import type { HarnessEvent } from '../events';
import type { ItemDraft } from '../ports/ItemLog';
import type { ToolOutput } from '../ports/ToolGateway';
import type { AdvanceRunDeps, AdvanceRunRequest } from '../types';
import { runAfterToolCall, settle } from './hooks';
import { msSince, observeResults, type ResultMeasure } from './observe';
import { UPDATE_PLAN_TOOL_ID, executeUpdatePlan } from './plan';
import {
  LOAD_SKILL_TOOL_ID,
  executeLoadSkill,
  resolveAgentSkills,
} from './skills';

/**
 * Calls that may run together: a stretch of read-only calls, or one call that
 * is not read-only. Results are written in the order of `position` either way
 * (P-03).
 */
type Batch = { calls: ToolCallItem[]; concurrent: boolean };

/**
 * What became of one call: a draft to write (a result, or `denied`), nothing
 * to write (the call waits for a decision), or the run stopped before the
 * call had a result.
 */
type Outcome =
  | { kind: 'write'; drafts: ItemDraft[]; timedOut?: true }
  | { kind: 'skip' }
  | { kind: 'aborted' };

/** The result of a change that does not run after an earlier one went over its time. */
const AFTER_WRITE_TIMEOUT_MESSAGE =
  'Not run: an earlier change of this step did not answer in time and may still be running.';

/** The largest delay `setTimeout` takes. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Runs the calls of the last step that have no result (D-09, D-25, P-01 to
 * P-03).
 *
 * - A call runs only when its decision is `allow`: the `approval` of the user
 *   for a call that needs one (see `needsApproval`), or the policy for one that
 *   does not. A call the user denied gets a `denied` result and never runs. A
 *   call that needs approval and has no decision is left alone.
 * - A stretch of read-only calls runs at the same time, at most
 *   `limits.readConcurrency` of them. A call that is not read-only runs alone,
 *   after every call before it ended.
 * - The results are written in the order of `position`: a result is written
 *   once the calls before it have theirs, so a call that ends early waits for
 *   the ones before it.
 * - A call that is not read-only and goes over its time may still be making
 *   its change. The calls of the step that are not read-only and come after
 *   it do not run: they get a `denied` result that says so. Read-only calls
 *   run as usual and do not wait for it.
 * - A tool that is not read-only gets a `tool_started` item before it runs, so
 *   a backend that takes over after a crash never runs it twice.
 * - An interrupted call (started, no result) gets an `unknown` result. It does
 *   not run again.
 * - Each call has its own signal: it aborts when the run stops or when
 *   `limits.toolTimeoutSeconds` passed. A call over its time gets a `timeout`
 *   result and the run goes on. The loop does not wait for a tool that
 *   ignores the signal.
 * - A failure of the tool, or no answer from it, is an `error` result; it does
 *   not end the run. When the signal of the run aborts, the calls without a
 *   result are left as they are; the results that are in are written, in
 *   order, and no call starts.
 * - `update_plan` runs in the core: a valid call writes a `plan_update` item
 *   and its result in one append, at the place of the call. Its
 *   `afterToolCall` hooks run before that append.
 * - The `afterToolCall` hooks may change the result before it is written. They
 *   run when the tool of their call ended, so the hooks of the calls of one
 *   stretch may run at the same time. The tool has run by then, so a stop
 *   while they run writes an `error` result.
 * - Before each call that is not read-only the loop asks `heartbeat`. When the
 *   user asked to stop, this returns `'cancelled'` and the call does not start.
 * - A decision that is neither `allow` nor `deny` throws.
 *
 * Each item is written when it is ready, so a crash keeps what is done.
 */
export async function* executeTools(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  items: readonly Item[],
  action: { calls: ToolCallItem[]; interrupted: ToolCallItem[] },
): AsyncGenerator<HarnessEvent, 'cancelled' | undefined> {
  const calls = new Map(
    [...action.interrupted, ...action.calls].map(call => [call.callId, call]),
  );
  // What the loop knows of each result besides the item, for the observer.
  const measures = new Map<string, ResultMeasure>();
  async function* write(
    ...drafts: ItemDraft[]
  ): AsyncGenerator<HarnessEvent, void> {
    const written = await deps.items.append(
      req.ctx.sessionId,
      drafts,
      req.fence,
    );
    observeResults(
      deps,
      req,
      written,
      callId => calls.get(callId),
      callId => measures.get(callId),
    );
    for (const item of written) yield { type: 'item.completed', item };
  }

  if (action.interrupted.length > 0) {
    const unknown = action.interrupted.map<ItemDraft>(call => ({
      kind: 'tool_result',
      callId: call.callId,
      status: 'unknown',
      message:
        'The call started but its result was lost. It may or may not have run, and it is not run again.',
    }));
    yield* write(...unknown);
  }

  // A change that went over its time may still run: the later changes of the
  // step must not overtake it (D-09).
  let writeTimedOut = writeTimedOutIn(items, action.calls);
  for (const batch of batchesOf(action.calls)) {
    if (req.signal.aborted) return undefined;
    if (batch.concurrent) {
      const done = yield* runConcurrently(
        deps,
        req,
        items,
        batch.calls,
        write,
        measures,
      );
      if (done === 'aborted') return undefined;
      continue;
    }
    const [call] = batch.calls;
    const decision = decisionFor(items, call);
    if (decision === 'allow' && writeTimedOut) {
      measures.set(call.callId, { reason: 'earlier_write_timed_out' });
      yield* write({
        kind: 'tool_result',
        callId: call.callId,
        status: 'denied',
        message: AFTER_WRITE_TIMEOUT_MESSAGE,
      });
      continue;
    }
    if (decision === 'allow') {
      // The user may have asked to stop while an earlier call ran. Ask
      // before each call that is not read-only, so no more of them start.
      const { cancelRequested } = await deps.run.heartbeat(req.fence);
      if (cancelRequested) return 'cancelled';
      if (req.signal.aborted) return undefined;
      yield* write({ kind: 'tool_started', callId: call.callId });
      if (req.signal.aborted) return undefined;
    }
    const outcome = await settleCall(deps, req, call, decision, measures);
    if (outcome.kind === 'aborted') return undefined;
    if (outcome.kind === 'write') {
      if (outcome.timedOut) writeTimedOut = true;
      yield* write(...outcome.drafts);
    }
  }
  return undefined;
}

/**
 * Whether a call of the step of `calls` that is not read-only already has a
 * `timeout` result in the log: a run that goes on after a takeover keeps the
 * rule of one step.
 */
function writeTimedOutIn(
  items: readonly Item[],
  calls: readonly ToolCallItem[],
): boolean {
  const [first] = calls;
  if (!first) return false;
  const writes = new Set(
    items.flatMap(item =>
      item.kind === 'tool_call' &&
      item.runId === first.runId &&
      item.step === first.step &&
      item.readOnly !== true
        ? [item.callId]
        : [],
    ),
  );
  return items.some(
    item =>
      item.kind === 'tool_result' &&
      item.status === 'timeout' &&
      writes.has(item.callId),
  );
}

/**
 * Runs a stretch of read-only calls, at most `readConcurrency` at a time, and
 * writes their results in order. `'aborted'` means the run stopped; the
 * results that were in are written.
 */
async function* runConcurrently(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  items: readonly Item[],
  calls: readonly ToolCallItem[],
  write: (...drafts: ItemDraft[]) => AsyncGenerator<HarnessEvent, void>,
  measures: Map<string, ResultMeasure>,
): AsyncGenerator<HarnessEvent, 'aborted' | undefined> {
  const limit = Math.max(1, req.limits.readConcurrency);
  const decisions = calls.map(call => decisionFor(items, call));
  const outcomes: (Outcome | undefined)[] = calls.map(() => undefined);
  const running = new Set<Promise<void>>();
  // Ends the calls still running when the stretch is left, also by an error.
  const stop = new AbortController();
  const callReq: AdvanceRunRequest = {
    ...req,
    signal: AbortSignal.any([req.signal, stop.signal]),
  };
  const stopped = abortOf(req.signal);
  let started = 0;
  let written = 0;
  try {
    for (;;) {
      while (written < calls.length && outcomes[written] !== undefined) {
        const outcome = outcomes[written++]!;
        if (outcome.kind === 'write') yield* write(...outcome.drafts);
      }
      if (written === calls.length) return undefined;
      if (req.signal.aborted) {
        // Every call waits on the signal (`settle`), so the ones running end
        // at once: a call with no result yet, or one whose tool ended and
        // whose hooks are cut short, which is an `error` result. What ended
        // is kept (H-06), still in order.
        await Promise.all(running);
        for (let i = written; i < calls.length; i++) {
          const outcome = outcomes[i];
          if (outcome?.kind === 'write') yield* write(...outcome.drafts);
        }
        return 'aborted';
      }
      while (started < calls.length && running.size < limit) {
        const index = started++;
        const task: Promise<void> = settleCall(
          deps,
          callReq,
          calls[index],
          decisions[index],
          measures,
        ).then(outcome => {
          outcomes[index] = outcome;
          running.delete(task);
        });
        running.add(task);
      }
      await Promise.race([...running, stopped.promise]);
    }
  } finally {
    stop.abort();
    stopped.dispose();
  }
}

function decisionFor(
  items: readonly Item[],
  call: ToolCallItem,
): 'allow' | 'deny' | undefined {
  const decision = needsApproval(call)
    ? decisionOf(items, call.callId)
    : 'allow';
  if (decision !== 'allow' && decision !== 'deny' && decision !== undefined) {
    throw new Error(
      `The decision of call ${call.callId} is not allow or deny: ${String(
        decision,
      )}`,
    );
  }
  return decision;
}

/**
 * The outcome of one call with its decision: runs it when it is `allow`,
 * within its time, and passes the result through the `afterToolCall` hooks.
 * What it measures goes to `measures`.
 */
async function settleCall(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  call: ToolCallItem,
  decision: 'allow' | 'deny' | undefined,
  measures: Map<string, ResultMeasure>,
): Promise<Outcome> {
  if (decision === undefined) return { kind: 'skip' };
  if (decision === 'deny') {
    measures.set(call.callId, { reason: 'user' });
    return {
      kind: 'write',
      drafts: [
        {
          kind: 'tool_result',
          callId: call.callId,
          status: 'denied',
          message: 'The user denied this call.',
        },
      ],
    };
  }
  if (call.toolId === UPDATE_PLAN_TOOL_ID) {
    // The plan is the effect of the call, written with its result at the
    // place of the call. The hooks see the result before that write.
    const updated = executeUpdatePlan(call);
    const output = await runAfterToolCall(
      deps.extensions,
      call,
      updated.output,
      req.signal,
    );
    return {
      kind: 'write',
      drafts: [
        ...(updated.plan
          ? [{ kind: 'plan_update' as const, plan: updated.plan }]
          : []),
        resultOf(call, output),
      ],
    };
  }
  const ran = await runInTime(deps, req, call);
  if (!ran) return { kind: 'aborted' };
  const { output: raw, durationMs } = ran;
  measures.set(call.callId, { durationMs });
  const output = await runAfterToolCall(deps.extensions, call, raw, req.signal);
  return {
    kind: 'write',
    drafts: [resultOf(call, output)],
    ...(raw.status === 'timeout' && { timedOut: true as const }),
  };
}

/**
 * Runs one call with a signal that also aborts after `toolTimeoutSeconds`
 * (P-02), and how long it took. `undefined` means the run stopped first.
 */
async function runInTime(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  call: ToolCallItem,
): Promise<{ output: ToolOutput; durationMs: number } | undefined> {
  const startedAt = deps.clock.now().getTime();
  const output = await runWithTimeout(deps, req, call);
  return output && { output, durationMs: msSince(deps, startedAt) };
}

async function runWithTimeout(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  call: ToolCallItem,
): Promise<ToolOutput | undefined> {
  const seconds = req.limits.toolTimeoutSeconds;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(),
    Math.min(Math.max(0, seconds * 1000), MAX_TIMER_MS),
  );
  // A host that drops the generator must not be kept alive by the timer.
  timer.unref?.();
  const signal = AbortSignal.any([req.signal, timeout.signal]);
  try {
    // A tool that ignores the signal must not hold up the step.
    const settled = await settle(
      () => run(deps, { ...req, signal }, call),
      signal,
    );
    if (!settled.aborted && settled.ok && settled.value) return settled.value;
    if (req.signal.aborted) return undefined;
    if (timeout.signal.aborted) {
      return {
        status: 'timeout',
        message:
          call.readOnly === true
            ? `The tool did not answer within ${seconds} seconds.`
            : `The tool did not answer within ${seconds} seconds. It may still have made its change, and it is not run again.`,
      };
    }
    return { status: 'error', message: 'The tool gave no result.' };
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
}

/** A promise that resolves when the signal aborts, and its clean-up. */
function abortOf(signal: AbortSignal): {
  promise: Promise<void>;
  dispose: () => void;
} {
  let onAbort = () => {};
  const promise = new Promise<void>(resolve => {
    onAbort = () => resolve();
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', onAbort),
  };
}

function batchesOf(calls: readonly ToolCallItem[]): Batch[] {
  const batches: Batch[] = [];
  for (const call of calls) {
    const last = batches[batches.length - 1];
    if (call.readOnly === true && last?.concurrent) {
      last.calls.push(call);
    } else {
      batches.push({ calls: [call], concurrent: call.readOnly === true });
    }
  }
  return batches;
}

/** Runs one call. `undefined` means the signal aborted. */
async function run(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  call: ToolCallItem,
): Promise<ToolOutput | undefined> {
  if (call.toolId === LOAD_SKILL_TOOL_ID) {
    return executeLoadSkill(
      call,
      req,
      resolveAgentSkills(req.agent, deps.extensions.skills),
    );
  }
  try {
    const output = await deps.tools.execute(call, req.ctx, {
      signal: req.signal,
    });
    if (
      typeof output === 'object' &&
      output !== null &&
      !Array.isArray(output)
    ) {
      return output;
    }
    return req.signal.aborted
      ? undefined
      : { status: 'error', message: 'The tool gave no result.' };
  } catch (error) {
    if (req.signal.aborted) return undefined;
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resultOf(call: ToolCallItem, output: ToolOutput): ToolResultBody {
  return {
    kind: 'tool_result',
    callId: call.callId,
    status: output.status,
    ...(output.output !== undefined ? { output: output.output } : {}),
    ...(output.truncated !== undefined ? { truncated: output.truncated } : {}),
    ...(output.message !== undefined ? { message: output.message } : {}),
  };
}

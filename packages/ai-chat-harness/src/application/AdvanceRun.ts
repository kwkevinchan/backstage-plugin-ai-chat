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

import { decideNextAction, type Item, type RunUsage } from '../domain';
import type { HarnessEvent, RunOutcome } from './events';
import { callModel } from './steps/callModel';
import { executeTools } from './steps/executeTools';
import { runOnRunEnd } from './steps/hooks';
import type { AdvanceRunDeps, AdvanceRunRequest } from './types';

/**
 * The loop of the agent (D-18). It keeps no state between steps: each step
 * reads the log and `decideNextAction` says what comes next. So the same call
 * continues a run after an approval, on any backend, and takes over a run whose
 * backend crashed.
 *
 * The run ends, and the generator returns, when the model has answered
 * (`completed`), a limit is reached (`completed` with `endReason`), a call
 * waits for the user (`waiting_approval`), the user asked to stop or the
 * signal aborted (`cancelled`), or the model call failed (`failed`). The same
 * outcome is the last event. Errors of the ports, such as `LeaseLost`, are
 * thrown and end the generator without a `run.ended` event; the host then sets
 * the status of the run itself.
 *
 * Before a model call whose input would not fit the context budget, the loop
 * has the old steps summarized (H-09): one more model call, written as a
 * `summary` item. It is not a step. When it fails the run goes on, and the
 * input leaves the old steps out.
 *
 * The working time of the run also ends a model call or a tool that is in
 * progress: both get a signal that aborts at the deadline, and the run ends as
 * `completed` with `endReason` `timeout`. The user stopping the run, by the
 * request of `heartbeat` or by the signal of the request, ends it as
 * `cancelled`. `heartbeat` is asked once per round of the loop and before each
 * call that is not read-only, and once after a summary is written.
 *
 * The deadline timer is `unref`ed, so it does not keep the process alive. The
 * host keeps the process alive until the generator ends. A host with no HTTP
 * server (a CLI, a worker, a demo script) must take care: with no other I/O
 * the process exits and the run is left unfinished.
 *
 * @public
 */
export class AdvanceRun {
  constructor(private readonly deps: AdvanceRunDeps) {}

  async *execute(
    req: AdvanceRunRequest,
  ): AsyncGenerator<HarnessEvent, RunOutcome> {
    yield { type: 'run.started', runId: req.fence.runId };
    const { outcome, usage } = yield* this.loop(req);
    yield { type: 'run.ended', outcome };
    if (outcome.status !== 'waiting_approval') {
      await runOnRunEnd(this.deps.extensions, {
        sessionId: req.ctx.sessionId,
        runId: req.fence.runId,
        agentId: req.agent.id,
        principal: req.ctx.principal,
        outcome,
        usage,
      });
    }
    return outcome;
  }

  private async *loop(
    req: AdvanceRunRequest,
  ): AsyncGenerator<HarnessEvent, { outcome: RunOutcome; usage: RunUsage }> {
    const deadline = deadlineOf(req);
    try {
      return yield* this.steps(req, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async *steps(
    outer: AdvanceRunRequest,
    deadline: Deadline,
  ): AsyncGenerator<HarnessEvent, { outcome: RunOutcome; usage: RunUsage }> {
    const { deps } = this;
    // The steps see the signal that also aborts at the deadline.
    const req: AdvanceRunRequest = { ...outer, signal: deadline.signal };
    const startedAt = deps.clock.now().getTime();
    const usage: RunUsage = { ...req.usage };
    const elapsed = () =>
      req.usage.elapsedSeconds +
      (deps.clock.now().getTime() - startedAt) / 1000;

    const end = async (
      outcome: RunOutcome,
    ): Promise<{ outcome: RunOutcome; usage: RunUsage }> => {
      usage.elapsedSeconds = elapsed();
      const recorded = { ...usage };
      await deps.run.recordUsage(req.fence, recorded);
      return { outcome, usage: recorded };
    };

    // A summary that failed is not tried again in this call of the loop.
    let summarize = true;
    // The parts of the input left out at the last step, as `callModel` keeps
    // them: `context.trimmed` is sent when they change.
    let trimmed = '';

    for (;;) {
      const { cancelRequested } = await deps.run.heartbeat(req.fence);
      if (cancelRequested || outer.signal.aborted) {
        return end({ status: 'cancelled' });
      }

      usage.elapsedSeconds = elapsed();
      // Only what the newest summary does not cover: it is all the steps need,
      // and the read stays short for a long session.
      const items = await deps.items.read(req.ctx.sessionId, {
        fromLatestSummary: true,
      });
      // A backend that crashed before `recordUsage` leaves steps in the log
      // that the stored usage does not count.
      usage.stepsUsed = Math.max(usage.stepsUsed, lastStepOf(items, req));
      const action = decideNextAction(items, usage, req.limits);

      switch (action.type) {
        case 'call_model': {
          const step = yield* callModel(deps, req, items, usage, {
            summarize,
            trimmed,
          });
          trimmed = step.trimmed ?? trimmed;
          if (step.summaryFailed) summarize = false;
          if (!step.noStep) usage.stepsUsed += 1;
          usage.toolCallsUsed += step.toolCallsRequested;
          const stopped = stoppedBy(outer, deadline);
          if (stopped) return end(stopped);
          if (step.outcome) return end(step.outcome);
          break;
        }
        case 'execute_tools': {
          const result = yield* executeTools(deps, req, items, action);
          const stopped = stoppedBy(outer, deadline);
          if (stopped) return end(stopped);
          if (result === 'cancelled') return end({ status: 'cancelled' });
          break;
        }
        case 'wait_approval':
          return end({ status: 'waiting_approval', pending: action.pending });
        case 'complete':
          return end({ status: 'completed' });
        case 'stop':
          return end({ status: 'completed', endReason: action.reason });
        default:
          return assertNever(action);
      }
      await deps.run.recordUsage(req.fence, {
        ...usage,
        elapsedSeconds: elapsed(),
      });
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected next action: ${JSON.stringify(value)}`);
}

/** The step number of the newest call of this run in the log, or 0. */
function lastStepOf(items: readonly Item[], req: AdvanceRunRequest): number {
  let last = 0;
  for (const item of items) {
    if (item.kind === 'tool_call' && item.runId === req.fence.runId) {
      last = Math.max(last, item.step);
    }
  }
  return last;
}

/** The largest delay `setTimeout` takes. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type Deadline = {
  /** Aborts when the caller aborts or the working time of the run is used up. */
  signal: AbortSignal;
  expired: () => boolean;
  dispose: () => void;
};

/**
 * The time left in the run, as a signal for the model call and the tools: a
 * call in progress ends at the deadline instead of running on. The timer is
 * real time; the loop also checks the working time between steps with the
 * clock port.
 */
function deadlineOf(req: AdvanceRunRequest): Deadline {
  const controller = new AbortController();
  let expired = false;
  const leftMs = Math.max(
    0,
    (req.limits.runTimeoutSeconds - req.usage.elapsedSeconds) * 1000,
  );
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, Math.min(leftMs, MAX_TIMER_MS));
  // A host that drops the generator must not be kept alive until the deadline.
  timer.unref?.();
  return {
    signal: AbortSignal.any([req.signal, controller.signal]),
    expired: () => expired,
    dispose: () => clearTimeout(timer),
  };
}

/** Why the run must end now, if it must: the user, or the deadline. */
function stoppedBy(
  outer: AdvanceRunRequest,
  deadline: Deadline,
): RunOutcome | undefined {
  if (outer.signal.aborted) return { status: 'cancelled' };
  if (deadline.expired()) return { status: 'completed', endReason: 'timeout' };
  return undefined;
}

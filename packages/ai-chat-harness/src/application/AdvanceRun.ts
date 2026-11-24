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

import { decideNextAction, type RunUsage } from '../domain';
import type { HarnessEvent, RunOutcome } from './events';
import { callModel } from './steps/callModel';
import { executeTools } from './steps/executeTools';
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
 * thrown and end the generator without a `run.ended` event.
 *
 * @public
 */
export class AdvanceRun {
  constructor(private readonly deps: AdvanceRunDeps) {}

  async *execute(
    req: AdvanceRunRequest,
  ): AsyncGenerator<HarnessEvent, RunOutcome> {
    yield { type: 'run.started', runId: req.fence.runId };
    const outcome = yield* this.loop(req);
    yield { type: 'run.ended', outcome };
    return outcome;
  }

  private async *loop(
    req: AdvanceRunRequest,
  ): AsyncGenerator<HarnessEvent, RunOutcome> {
    const { deps } = this;
    const startedAt = deps.clock.now().getTime();
    const usage: RunUsage = { ...req.usage };
    const elapsed = () =>
      req.usage.elapsedSeconds +
      (deps.clock.now().getTime() - startedAt) / 1000;

    const end = async (outcome: RunOutcome): Promise<RunOutcome> => {
      usage.elapsedSeconds = elapsed();
      await deps.run.recordUsage(req.fence, { ...usage });
      return outcome;
    };

    for (;;) {
      const { cancelRequested } = await deps.run.heartbeat(req.fence);
      if (cancelRequested || req.signal.aborted) {
        return end({ status: 'cancelled' });
      }

      usage.elapsedSeconds = elapsed();
      const items = await deps.items.read(req.ctx.sessionId);
      const action = decideNextAction(items, usage, req.limits);

      switch (action.type) {
        case 'call_model': {
          const step = yield* callModel(deps, req, items, usage);
          usage.stepsUsed += 1;
          usage.toolCallsUsed += step.toolCallsRequested;
          if (step.outcome) return end(step.outcome);
          break;
        }
        case 'execute_tools':
          yield* executeTools(deps, req, items, action);
          if (req.signal.aborted) return end({ status: 'cancelled' });
          break;
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

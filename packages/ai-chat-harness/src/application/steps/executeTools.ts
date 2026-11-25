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
import { runAfterToolCall } from './hooks';
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
 * Runs the calls of the last step that have no result (D-09, D-25).
 *
 * - A call runs only when its decision is `allow`: the `approval` of the user
 *   for a call that needs one (see `needsApproval`), or the policy for one that
 *   does not. A call the user denied gets a `denied` result and never runs. A
 *   call that needs approval and has no decision is left alone.
 * - A tool that is not read-only gets a `tool_started` item before it runs, so
 *   a backend that takes over after a crash never runs it twice.
 * - An interrupted call (started, no result) gets an `unknown` result. It does
 *   not run again.
 * - A failure of the tool, or no answer from it, is an `error` result; it does
 *   not end the run. When the signal aborts, the call is left as it is and
 *   nothing is written for it.
 * - The `afterToolCall` hooks may change the result before it is written. The
 *   tool has run by then, so a stop while they run writes an `error` result.
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
  async function* write(draft: ItemDraft): AsyncGenerator<HarnessEvent, void> {
    const [item] = await deps.items.append(
      req.ctx.sessionId,
      [draft],
      req.fence,
    );
    yield { type: 'item.completed', item };
  }

  if (action.interrupted.length > 0) {
    const unknown = action.interrupted.map<ItemDraft>(call => ({
      kind: 'tool_result',
      callId: call.callId,
      status: 'unknown',
      message:
        'The call started but its result was lost. It may or may not have run, and it is not run again.',
    }));
    const written = await deps.items.append(
      req.ctx.sessionId,
      unknown,
      req.fence,
    );
    for (const item of written) yield { type: 'item.completed', item };
  }

  for (const batch of batchesOf(action.calls)) {
    // P3 runs a concurrent batch with Promise.all and writes the results in
    // the order of `position`. Until then every call runs on its own.
    for (const call of batch.calls) {
      if (req.signal.aborted) return undefined;
      const decision = needsApproval(call)
        ? decisionOf(items, call.callId)
        : 'allow';

      if (decision === 'allow') {
        if (call.readOnly !== true) {
          // The user may have asked to stop while an earlier call ran. Ask
          // before each call that is not read-only, so no more of them start.
          const { cancelRequested } = await deps.run.heartbeat(req.fence);
          if (cancelRequested) return 'cancelled';
          if (req.signal.aborted) return undefined;
          yield* write({ kind: 'tool_started', callId: call.callId });
          if (req.signal.aborted) return undefined;
        }
        const raw = await run(deps, req, call);
        if (!raw) return undefined;
        const output = await runAfterToolCall(
          deps.extensions,
          call,
          raw,
          req.signal,
        );
        yield* write(resultOf(call, output));
      } else if (decision === 'deny') {
        yield* write({
          kind: 'tool_result',
          callId: call.callId,
          status: 'denied',
          message: 'The user denied this call.',
        });
      } else if (decision !== undefined) {
        throw new Error(
          `The decision of call ${call.callId} is not allow or deny: ${String(
            decision,
          )}`,
        );
      }
    }
  }
  return undefined;
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

/** Runs one call. `undefined` means the run was aborted. */
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

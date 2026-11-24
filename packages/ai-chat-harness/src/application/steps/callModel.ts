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
  buildModelInput,
  decidePolicy,
  type Item,
  type ItemBody,
  type JsonObject,
  type JsonValue,
  type RunUsage,
  type ToolCallBody,
  type ToolDescriptor,
  type ToolResultBody,
} from '../../domain';
import type { HarnessEvent, RunOutcome } from '../events';
import type { ItemDraft } from '../ports/ItemLog';
import type { ValidationResult } from '../ports/ToolGateway';
import type { AdvanceRunDeps, AdvanceRunRequest } from '../types';

/** What one model call left: how many calls the model asked for, or an end. */
export type CallModelResult = {
  toolCallsRequested: number;
  /** Set when the run ends here. */
  outcome?: RunOutcome;
};

type RequestedCall = {
  /** The id of the call in the log, also the `draftId` in the events. */
  callId: string;
  modelCallId: string;
  toolId: string;
  input: JsonValue;
};

/**
 * One model call: sends the model input, turns the answer into events, and
 * writes the answer to the log in one append, the text first (D-17).
 *
 * - `callId` comes from the `IdGenerator`, never from the model, and is taken
 *   when the call arrives: it is the `draftId` of the call in the events. The
 *   id of the model is the `modelCallId` of `item.started`.
 * - The policy of a call is always `decidePolicy` of the descriptor and the
 *   settings of the request.
 * - A call that cannot run gets its `tool_result` in the same append: `invalid`
 *   for an unknown tool, for input that is not an object, or for input that
 *   fails the schema (T-05; no approval is asked); `denied` when the policy
 *   says deny, and `denied` with the message "tool call limit" for every call
 *   beyond the calls the run may still make (H-05). A call that has its result
 *   at once is stored with policy `ask` when it was refused, as the item type
 *   has no `deny`; the result closes it.
 * - A model call with neither text nor calls writes nothing and fails the
 *   run: asking again would give the same input.
 *
 */
export async function* callModel(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  items: readonly Item[],
  usage: RunUsage,
): AsyncGenerator<HarnessEvent, CallModelResult> {
  // `usage.stepsUsed` already counts the steps the log shows for this run.
  const step = usage.stepsUsed + 1;
  const available = await deps.tools.list(req.ctx);
  const byId = new Map(available.map(tool => [tool.id, tool]));
  // A tool the policy denies is not offered to the model.
  const offered = available.filter(
    tool => decidePolicy(tool, req.policy) !== 'deny',
  );
  const input = buildModelInput(
    items,
    req.agent,
    // Context providers come with the extension points (P3).
    { context: [], tools: offered },
    req.budget,
  );

  yield { type: 'step.started', step };

  let text = '';
  let textDraftId: string | undefined;
  const requested: RequestedCall[] = [];
  try {
    for await (const chunk of deps.model.stream(input, {
      signal: req.signal,
    })) {
      if (chunk.type === 'text') {
        text += chunk.text;
        // Leading blank text is held back: a blank answer is not an item.
        if (text.trim().length === 0) continue;
        if (textDraftId === undefined) {
          textDraftId = deps.ids.next();
          yield {
            type: 'item.started',
            draftId: textDraftId,
            kind: 'agent_message',
          };
          yield { type: 'item.delta', draftId: textDraftId, text };
        } else if (chunk.text.length > 0) {
          yield { type: 'item.delta', draftId: textDraftId, text: chunk.text };
        }
      } else {
        const callId = deps.ids.next();
        requested.push({
          callId,
          modelCallId: chunk.modelCallId,
          toolId: chunk.toolId,
          input: chunk.input,
        });
        yield {
          type: 'item.started',
          draftId: callId,
          kind: 'tool_call',
          modelCallId: chunk.modelCallId,
        };
      }
    }
  } catch (error) {
    if (req.signal.aborted) {
      return { toolCallsRequested: 0, outcome: { status: 'cancelled' } };
    }
    return {
      toolCallsRequested: 0,
      outcome: {
        status: 'failed',
        message: 'The model call failed.',
        cause: error,
      },
    };
  }

  if (req.signal.aborted) {
    return { toolCallsRequested: 0, outcome: { status: 'cancelled' } };
  }

  const drafts: ItemDraft[] = [];
  const draftIds: (string | undefined)[] = [];
  if (text.trim().length > 0) {
    drafts.push({ kind: 'agent_message', text });
    draftIds.push(textDraftId);
  }

  const remaining = Math.max(
    0,
    req.limits.maxToolCallsPerRun - usage.toolCallsUsed,
  );
  const results: ItemBody[] = [];
  for (let position = 0; position < requested.length; position++) {
    const call = requested[position];
    const descriptor = byId.get(call.toolId);
    const { body, result } = await classify(deps, req, {
      call,
      callId: call.callId,
      descriptor,
      step,
      position,
      overLimit: position >= remaining,
    });
    drafts.push(body);
    draftIds.push(call.callId);
    if (result) results.push(result);
  }
  for (const result of results) {
    drafts.push(result);
    draftIds.push(undefined);
  }

  if (drafts.length === 0) {
    yield { type: 'step.ended', step };
    return {
      toolCallsRequested: 0,
      outcome: { status: 'failed', message: 'The model gave no answer.' },
    };
  }

  // Classifying awaits the validation, so the signal may have aborted since.
  if (req.signal.aborted) {
    return { toolCallsRequested: 0, outcome: { status: 'cancelled' } };
  }

  const written = await deps.items.append(req.ctx.sessionId, drafts, req.fence);
  for (let i = 0; i < written.length; i++) {
    yield {
      type: 'item.completed',
      ...(draftIds[i] ? { draftId: draftIds[i] } : {}),
      item: written[i],
    };
  }
  yield { type: 'step.ended', step };
  return { toolCallsRequested: requested.length };
}

async function classify(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  args: {
    call: RequestedCall;
    callId: string;
    descriptor: ToolDescriptor | undefined;
    step: number;
    position: number;
    overLimit: boolean;
  },
): Promise<{ body: ToolCallBody; result?: ToolResultBody }> {
  const { call, callId, descriptor, step, position, overLimit } = args;
  const base = { kind: 'tool_call' as const, callId, toolId: call.toolId };
  const refuse = (
    status: 'denied' | 'invalid',
    message: string,
    body: Omit<ToolCallBody, 'kind' | 'callId' | 'toolId'>,
  ) => ({
    body: { ...base, ...body },
    result: { kind: 'tool_result' as const, callId, status, message },
  });

  if (!descriptor) {
    return refuse('invalid', `Unknown tool: ${call.toolId}`, {
      input: {},
      schemaHash: '',
      policy: 'ask',
      readOnly: false,
      step,
      position,
    });
  }
  const isObject =
    typeof call.input === 'object' &&
    call.input !== null &&
    !Array.isArray(call.input);
  const fields = {
    input: isObject ? (call.input as JsonObject) : {},
    schemaHash: descriptor.schemaHash,
    readOnly: descriptor.readOnly === true,
    step,
    position,
  };
  const policy = decidePolicy(descriptor, req.policy);

  if (overLimit) {
    return refuse('denied', 'tool call limit', {
      ...fields,
      policy: policy === 'allow' ? 'allow' : 'ask',
    });
  }
  if (policy === 'deny') {
    return refuse('denied', 'The policy does not allow this tool.', {
      ...fields,
      policy: 'ask',
    });
  }
  if (!isObject) {
    return refuse('invalid', 'The input must be a JSON object.', {
      ...fields,
      policy,
    });
  }
  let validation: ValidationResult;
  try {
    validation = await deps.tools.validate(call.toolId, fields.input, req.ctx);
  } catch {
    return refuse('invalid', 'The input could not be checked.', {
      ...fields,
      policy,
    });
  }
  if (!validation.valid) {
    return refuse('invalid', validation.message, { ...fields, policy });
  }
  return { body: { ...base, ...fields, policy } };
}

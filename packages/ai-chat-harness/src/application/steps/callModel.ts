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
  decidePolicy,
  modelInputOf,
  planSummary,
  unreadInserted,
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
import type { Skill, StepContext } from '../ports/extensions';
import type { ItemDraft } from '../ports/ItemLog';
import type { ModelCallRecord, ToolDeniedReason } from '../ports/RunObserver';
import type { ValidationResult } from '../ports/ToolGateway';
import type { AdvanceRunDeps, AdvanceRunRequest } from '../types';
import {
  runBeforeModelCall,
  runBeforeToolCall,
  toolCallFromParts,
} from './hooks';
import {
  LOAD_SKILL_TOOL_ID,
  loadSkillDescriptor,
  resolveAgentSkills,
  skillsContextBlock,
  validateLoadSkillInput,
} from './skills';
import { runContextProviders } from './contextProviders';
import {
  PLAN_FIRST_NOTICE,
  UPDATE_PLAN_TOOL_ID,
  updatePlanDescriptor,
  validateUpdatePlanInput,
} from './plan';
import {
  abortedOutcome,
  errorStatusOf,
  msSince,
  observeModelCall,
  observeResults,
  usageOf,
  type ResultMeasure,
} from './observe';
import { stepContextOf } from './stepContext';
import { summarize } from './summarize';

/** What one model call left: how many calls the model asked for, or an end. */
export type CallModelResult = {
  toolCallsRequested: number;
  /** Set when the run ends here. */
  outcome?: RunOutcome;
  /** The summary failed: the loop does not try again in this call. */
  summaryFailed?: true;
  /**
   * What the model input left out, as a key (`earlier`, `steps`, both joined
   * with a comma, or empty). The loop passes it back as `trimmed` of the next
   * call, so the same notice is not sent at every step.
   */
  trimmed?: string;
  /** The call ended while it made the summary, before a step began. */
  noStep?: true;
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
 *   beyond the calls the run may still make (H-05), or "tool call limit per
 *   step" for every call beyond `maxToolCallsPerStep` (P-05). Both count as
 *   requested calls of the run. A call that has its result
 *   at once is stored with policy `ask` when it was refused, as the item type
 *   has no `deny`; the result closes it.
 * - A model call with neither text nor calls writes nothing and fails the
 *   run: asking again would give the same input.
 * - Each item of the model output has `readUpToSeq`: the largest `seq` of the
 *   log as the loop read it for this call (`items`). The summary this call may
 *   write is not counted: a message inserted while it was made is not read.
 * - `message.read` is sent, before `step.started`, for each inserted message
 *   this call is the first to give to the model (`unreadInserted(items)`).
 * - Every step offers the built-in `update_plan` with the other tools (X-06).
 *   The current plan comes into the context through the context provider
 *   `plan` (`planContextProvider`), like every other provider: after the
 *   `beforeModelCall` hooks, before the budget is checked (X-03). The first
 *   step of a run of an agent with `planning: 'required'` offers only
 *   `update_plan`; a call of another tool there is `invalid` (X-07).
 * - When the input would be over the budget even with the old tool outputs
 *   shortened, the old steps are summarized first (`summarize`; H-09), unless
 *   `summarize` is false. The summary is not a step. If it fails, the model is
 *   called anyway with the old steps left out, and the result says so.
 */
export async function* callModel(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  items: readonly Item[],
  usage: RunUsage,
  opts: { summarize: boolean; trimmed?: string },
): AsyncGenerator<HarnessEvent, CallModelResult> {
  // `usage.stepsUsed` already counts the steps the log shows for this run.
  const step = usage.stepsUsed + 1;
  const stepCtx = stepContextOf(req, step);
  const before = await runBeforeModelCall(deps.extensions, stepCtx);
  if (!before.ok) {
    return {
      toolCallsRequested: 0,
      outcome: before.aborted
        ? { status: 'cancelled' }
        : {
            status: 'failed',
            message: 'The model call failed.',
            cause: before.error,
          },
      noStep: true,
    };
  }
  const activeSkills = resolveAgentSkills(req.agent, deps.extensions.skills);
  const externalTools = (await deps.tools.list(req.ctx)).filter(
    tool => tool.id !== LOAD_SKILL_TOOL_ID && tool.id !== UPDATE_PLAN_TOOL_ID,
  );
  const loadSkillTool =
    activeSkills.length > 0 ? loadSkillDescriptor(activeSkills) : undefined;
  const loadSkillOffered =
    loadSkillTool !== undefined &&
    decidePolicy(loadSkillTool, req.policy) !== 'deny';
  const planTool = updatePlanDescriptor();
  // An agent that plans first gets only `update_plan` in the first step of a
  // run (X-07); a call of another tool in that step is refused.
  const planFirst = req.agent.planning === 'required' && step === 1;
  const available = planFirst
    ? [planTool]
    : [...externalTools, ...(loadSkillTool ? [loadSkillTool] : []), planTool];
  const byId = new Map(available.map(tool => [tool.id, tool]));
  // A tool the policy denies is not offered to the model.
  const offered = available.filter(
    tool => decidePolicy(tool, req.policy) !== 'deny',
  );
  const planOffered = offered.includes(planTool);
  const firstStepNote = planOffered
    ? `Only ${UPDATE_PLAN_TOOL_ID} is available in this step: write the plan first.`
    : 'No tool is available in this step.';
  const provided = await runContextProviders(deps.extensions, stepCtx);
  if (provided.aborted) {
    return {
      toolCallsRequested: 0,
      outcome: { status: 'cancelled' },
      noStep: true,
    };
  }
  const extra = {
    context: [
      ...(loadSkillOffered && !planFirst
        ? [skillsContextBlock(activeSkills)]
        : []),
      ...(planFirst && planOffered ? [PLAN_FIRST_NOTICE] : []),
      ...(provided.text !== undefined ? [provided.text] : []),
    ],
    tools: offered,
    images: req.model.capabilities.images,
  };

  let current = items;
  let summaryFailed = false;
  const plan = opts.summarize
    ? planSummary(items, req.agent, extra, req.budget)
    : undefined;
  if (plan) {
    const made = yield* summarize(deps, req, plan, step);
    if (made.status === 'aborted') {
      return {
        toolCallsRequested: 0,
        outcome: { status: 'cancelled' },
        noStep: true,
      };
    }
    if (made.status === 'written') {
      current = [...items, made.item];
      // The summary took time: a stop request that came in meanwhile counts.
      const { cancelRequested } = await deps.run.heartbeat(req.fence);
      if (cancelRequested) {
        return {
          toolCallsRequested: 0,
          outcome: { status: 'cancelled' },
          noStep: true,
        };
      }
    } else {
      summaryFailed = true;
    }
  }
  const {
    input,
    trimmed,
    size: context,
  } = modelInputOf(current, req.agent, extra, req.budget);
  const parts = [
    ...(trimmed.earlier ? (['earlier'] as const) : []),
    ...(trimmed.steps ? (['steps'] as const) : []),
  ];
  const trimmedKey = parts.join(',');
  // Only a change is reported: the same parts at every step would repeat the
  // notice on the screen.
  if (parts.length > 0 && trimmedKey !== (opts.trimmed ?? '')) {
    yield { type: 'context.trimmed', parts };
  }

  // What the log holds now is what this call reads. Items that arrive later
  // are for the next call, whatever the summary or the model take in between.
  const readUpToSeq = items.reduce((max, item) => Math.max(max, item.seq), 0);
  for (const message of unreadInserted(items)) {
    yield { type: 'message.read', item: message };
  }

  yield { type: 'step.started', step };

  let text = '';
  let textDraftId: string | undefined;
  const requested: RequestedCall[] = [];
  let reported: { inputTokens: number; outputTokens: number } | undefined;
  const startedAt = deps.clock.now().getTime();
  const observe = (outcome: ModelCallRecord['outcome'], errorStatus?: number) =>
    observeModelCall(deps, req, {
      purpose: 'step',
      step,
      durationMs: msSince(deps, startedAt),
      outcome,
      ...(errorStatus !== undefined && { errorStatus }),
      ...reported,
      toolCallsRequested: requested.length,
      context,
      ...(provided.providers.length > 0 && { providers: provided.providers }),
    });
  try {
    for await (const chunk of req.model.stream(input, {
      signal: req.signal,
      sessionId: req.ctx.sessionId,
    })) {
      if (chunk.type === 'usage') {
        reported = usageOf(chunk) ?? reported;
      } else if (chunk.type === 'text') {
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
      } else if (chunk.type === 'tool_call') {
        // A chunk of another type, from a newer or a foreign client, is ignored.
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
      observe(abortedOutcome(req.signal));
      return { toolCallsRequested: 0, outcome: { status: 'cancelled' } };
    }
    observe('failed', errorStatusOf(error));
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
    observe(abortedOutcome(req.signal));
    return { toolCallsRequested: 0, outcome: { status: 'cancelled' } };
  }
  observe(text.trim().length === 0 && requested.length === 0 ? 'empty' : 'ok');

  const drafts: ItemDraft[] = [];
  const draftIds: (string | undefined)[] = [];
  if (text.trim().length > 0) {
    drafts.push({ kind: 'agent_message', text, readUpToSeq });
    draftIds.push(textDraftId);
  }

  const remaining = Math.max(
    0,
    req.limits.maxToolCallsPerRun - usage.toolCallsUsed,
  );
  const results: ItemBody[] = [];
  const measures = new Map<string, ResultMeasure>();
  for (let position = 0; position < requested.length; position++) {
    const call = requested[position];
    const descriptor = byId.get(call.toolId);
    const classified = await classify(deps, req, {
      call,
      callId: call.callId,
      descriptor,
      activeSkills,
      firstStepNote: planFirst ? firstStepNote : undefined,
      step,
      position,
      overLimit: limitOf(position, remaining, req.limits.maxToolCallsPerStep),
      stepCtx,
    });
    if (classified.aborted) {
      return { toolCallsRequested: 0, outcome: { status: 'cancelled' } };
    }
    drafts.push({ ...classified.body, readUpToSeq });
    draftIds.push(call.callId);
    if (classified.result) results.push(classified.result);
    if (classified.reason || classified.unknownTool) {
      measures.set(call.callId, {
        ...(classified.reason && { reason: classified.reason }),
        ...(classified.unknownTool && { unknownTool: true }),
      });
    }
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
  const calls = new Map(
    written.flatMap(item =>
      item.kind === 'tool_call' ? [[item.callId, item] as const] : [],
    ),
  );
  observeResults(
    deps,
    req,
    written,
    callId => calls.get(callId),
    callId => measures.get(callId),
  );
  for (let i = 0; i < written.length; i++) {
    yield {
      type: 'item.completed',
      ...(draftIds[i] ? { draftId: draftIds[i] } : {}),
      item: written[i],
    };
  }
  yield { type: 'step.ended', step };
  return {
    toolCallsRequested: requested.length,
    trimmed: trimmedKey,
    ...(summaryFailed ? { summaryFailed: true as const } : {}),
  };
}

const RUN_LIMIT_MESSAGE = 'tool call limit';

/**
 * The message of the limit a call at `position` is beyond: the calls the run
 * may still make, then the calls of one step.
 */
function limitOf(
  position: number,
  remaining: number,
  perStep: number,
): string | undefined {
  if (position >= remaining) return RUN_LIMIT_MESSAGE;
  if (position >= perStep) return 'tool call limit per step';
  return undefined;
}

async function classify(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  args: {
    call: RequestedCall;
    callId: string;
    descriptor: ToolDescriptor | undefined;
    activeSkills: readonly Skill[];
    /** Set in the first step of an agent that plans first: why a tool is missing. */
    firstStepNote: string | undefined;
    step: number;
    position: number;
    /** The message of the limit the call is beyond, if any. */
    overLimit?: string;
    stepCtx: StepContext;
  },
): Promise<
  | { aborted: true }
  | {
      aborted?: false;
      body: ToolCallBody;
      result?: ToolResultBody;
      reason?: ToolDeniedReason;
      /** The model named a tool that is not offered: its name is the model's. */
      unknownTool?: true;
    }
> {
  const {
    call,
    callId,
    descriptor,
    activeSkills,
    firstStepNote,
    step,
    position,
    overLimit,
    stepCtx,
  } = args;
  const base = { kind: 'tool_call' as const, callId, toolId: call.toolId };
  const refuse = (
    status: 'denied' | 'invalid',
    message: string,
    body: Omit<ToolCallBody, 'kind' | 'callId' | 'toolId'>,
    reason?: ToolDeniedReason,
  ) => ({
    body: { ...base, ...body },
    result: {
      kind: 'tool_result' as const,
      callId,
      status,
      ...(status === 'denied' &&
        reason !== undefined && { deniedReason: reason }),
      message,
    },
    ...(reason !== undefined && { reason }),
  });

  if (!descriptor) {
    const message = firstStepNote ?? `Unknown tool: ${call.toolId}`;
    return {
      ...refuse('invalid', message, {
        input: {},
        schemaHash: '',
        policy: 'ask',
        readOnly: false,
        step,
        position,
      }),
      unknownTool: true,
    };
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

  if (overLimit !== undefined) {
    return refuse(
      'denied',
      overLimit,
      { ...fields, policy: policy === 'allow' ? 'allow' : 'ask' },
      overLimit === RUN_LIMIT_MESSAGE ? 'run_limit' : 'step_limit',
    );
  }
  if (policy === 'deny') {
    return refuse(
      'denied',
      'The policy does not allow this tool.',
      { ...fields, policy: 'ask' },
      'policy',
    );
  }
  if (!isObject) {
    return refuse('invalid', 'The input must be a JSON object.', {
      ...fields,
      policy,
    });
  }
  let validation: ValidationResult;
  try {
    if (call.toolId === LOAD_SKILL_TOOL_ID) {
      validation = validateLoadSkillInput(fields.input, activeSkills);
    } else if (call.toolId === UPDATE_PLAN_TOOL_ID) {
      validation = validateUpdatePlanInput(fields.input);
    } else {
      validation = await deps.tools.validate(
        call.toolId,
        fields.input,
        req.ctx,
      );
    }
  } catch {
    return refuse('invalid', 'The input could not be checked.', {
      ...fields,
      policy,
    });
  }
  if (!validation.valid) {
    return refuse('invalid', validation.message, { ...fields, policy });
  }
  const hookDecision = await runBeforeToolCall(
    deps.extensions,
    toolCallFromParts({
      callId,
      toolId: call.toolId,
      input: fields.input,
      readOnly: fields.readOnly,
      step,
      position,
    }),
    policy,
    stepCtx,
  );
  if (hookDecision.aborted) {
    return { aborted: true };
  }
  if (hookDecision.action === 'deny') {
    return refuse(
      'denied',
      hookDecision.reason,
      { ...fields, policy: 'ask' },
      'hook',
    );
  }
  return {
    body: {
      ...base,
      ...fields,
      policy: fields.readOnly ? hookDecision.action : 'ask',
    },
  };
}

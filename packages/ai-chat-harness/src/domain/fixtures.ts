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

// Builders for the tests of this circle. Not exported from the package.

import type { AgentDefinition, Limits } from './agent';
import type { Item, ItemBody, JsonObject, ToolResultStatus } from './item';
import type { ContextBudget } from './modelInput';
import type { RunUsage } from './run';
import type { ToolDescriptor } from './tool';

/** Gives each body the next sequence number of one session. */
export function log(...bodies: ItemBody[]): Item[] {
  return bodies.map(
    (body, index) =>
      ({
        ...body,
        sessionId: 'session-1',
        seq: index + 1,
        runId: (body as { runId?: string }).runId ?? 'run-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as Item),
  );
}

/** Marks bodies as written by another run than the default `run-1`. */
export const inRun = (runId: string, ...bodies: ItemBody[]): ItemBody[] =>
  bodies.map(body => ({ ...body, runId } as unknown as ItemBody));

export const user = (text = 'question'): ItemBody => ({
  kind: 'user_message',
  text,
});

/** A message of the user inserted into a run that was running. */
export const inserted = (text = 'insert'): ItemBody => ({
  kind: 'user_message',
  text,
  delivery: 'inserted',
});

/** `readUpToSeq` is the mark of the model output; none is a record of P1. */
export const agentSays = (text = 'answer', readUpToSeq?: number): ItemBody => ({
  kind: 'agent_message',
  text,
  ...(readUpToSeq !== undefined ? { readUpToSeq } : {}),
});

export function call(
  callId: string,
  options: {
    step?: number;
    position?: number;
    policy?: 'allow' | 'ask';
    readOnly?: boolean;
    toolId?: string;
    input?: JsonObject;
    readUpToSeq?: number;
  } = {},
): ItemBody {
  const policy = options.policy ?? 'allow';
  return {
    kind: 'tool_call',
    callId,
    toolId: options.toolId ?? 'catalog:get-entity',
    input: options.input ?? {},
    schemaHash: 'hash',
    policy,
    readOnly: options.readOnly ?? policy === 'allow',
    step: options.step ?? 1,
    position: options.position ?? 0,
    ...(options.readUpToSeq !== undefined
      ? { readUpToSeq: options.readUpToSeq }
      : {}),
  };
}

export const approve = (
  callId: string,
  decision: 'allow' | 'deny' = 'allow',
): ItemBody => ({ kind: 'approval', callId, decision, decidedBy: 'user:a' });

export const started = (callId: string): ItemBody => ({
  kind: 'tool_started',
  callId,
});

export const result = (
  callId: string,
  status: ToolResultStatus = 'ok',
  rest: { output?: JsonObject; message?: string; truncated?: boolean } = {},
): ItemBody => ({ kind: 'tool_result', callId, status, ...rest });

export const note = (text = 'note'): ItemBody => ({ kind: 'note', text });

export const summary = (coversUpToSeq: number): ItemBody => ({
  kind: 'summary',
  coversUpToSeq,
  text: 'summary',
});

export const limits: Limits = {
  maxSteps: 10,
  maxToolCallsPerRun: 30,
  runTimeoutSeconds: 300,
  maxToolCallsPerStep: 8,
  readConcurrency: 4,
  toolTimeoutSeconds: 60,
};

export const usage = (partial: Partial<RunUsage> = {}): RunUsage => ({
  stepsUsed: 1,
  toolCallsUsed: 0,
  elapsedSeconds: 1,
  ...partial,
});

export const agent: AgentDefinition = {
  id: 'default',
  systemPrompt: 'You are a helpful agent.',
};

export const budget: ContextBudget = { tokenBudget: 24000, keepRecentSteps: 6 };

export const tool = (
  partial: Partial<ToolDescriptor> = {},
): ToolDescriptor => ({
  id: 'catalog:get-entity',
  description: 'Gets an entity',
  inputSchema: { type: 'object' },
  schemaHash: 'hash',
  readOnly: true,
  ...partial,
});

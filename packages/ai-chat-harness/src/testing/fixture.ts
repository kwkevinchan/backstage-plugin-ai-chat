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

// The kit of the tests of the loop: the fakes wired together, with a session
// that holds a lease. It is not exported from the package.

import {
  AdvanceRun,
  type AdvanceRunRequest,
  type HarnessEvent,
  type ItemDraft,
  type RunFence,
  type RunOutcome,
} from '../application';
import type {
  ContextBudget,
  Item,
  ItemBody,
  Limits,
  PolicySettings,
  RunUsage,
} from '../domain';
import { FakeClock, FakeRunControl, SequentialIdGenerator } from './fakes';
import { FakeToolGateway, type FakeTool } from './FakeToolGateway';
import { InMemoryItemLog } from './InMemoryItemLog';
import { ScriptedModel, type ScriptedStep } from './ScriptedModel';

export const sessionId = 'session-1';
export const fence: RunFence = { runId: 'run-1', leaseOwner: 'backend-a' };

export const defaultLimits: Limits = {
  maxSteps: 10,
  maxToolCallsPerRun: 30,
  runTimeoutSeconds: 300,
};

export async function kit(options: {
  script: ScriptedStep[];
  tools?: FakeTool[];
  limits?: Partial<Limits>;
  policy?: PolicySettings;
  budget?: ContextBudget;
  /** What the scripted model can do, besides the defaults of `ScriptedModel`. */
  capabilities?: ConstructorParameters<typeof ScriptedModel>[1];
  /** The log before the run: the first item is normally a user message. */
  log?: ItemBody[];
}) {
  const clock = new FakeClock();
  const items = new InMemoryItemLog({ clock });
  items.grantLease(sessionId, fence);
  const model = new ScriptedModel(options.script, options.capabilities);
  const tools = new FakeToolGateway(options.tools ?? []);
  const run = new FakeRunControl();
  const ids = new SequentialIdGenerator('call');
  const controller = new AbortController();
  const limits = { ...defaultLimits, ...options.limits };
  const loop = new AdvanceRun({
    items,
    model,
    tools,
    run,
    clock,
    ids,
    extensions: {},
  });

  const append = (...bodies: ItemBody[]): Promise<Item[]> =>
    items.append(sessionId, bodies as ItemDraft[], fence);

  const lastUsage = (): RunUsage =>
    run.usage[run.usage.length - 1] ?? {
      stepsUsed: 0,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    };

  const request = (
    usage: RunUsage = lastUsage(),
    runFence: RunFence = fence,
  ): AdvanceRunRequest => ({
    agent: { id: 'default', systemPrompt: 'You are a helpful agent.' },
    limits,
    budget: options.budget ?? { tokenBudget: 24000, keepRecentSteps: 6 },
    policy: options.policy ?? {},
    fence: runFence,
    ctx: { sessionId, runId: runFence.runId, principal: { user: 'user:a' } },
    signal: controller.signal,
    usage,
  });

  /** Runs the loop once, as the host does, and collects what it reports. */
  const execute = async (
    usage?: RunUsage,
    runFence?: RunFence,
  ): Promise<{ events: HarnessEvent[]; outcome: RunOutcome }> => {
    const events: HarnessEvent[] = [];
    const generator = loop.execute(request(usage, runFence));
    for (;;) {
      const next = await generator.next();
      if (next.done) return { events, outcome: next.value };
      events.push(next.value);
    }
  };

  await append(
    ...(options.log ?? [
      { kind: 'user_message', text: 'question' } as ItemBody,
    ]),
  );

  return {
    items,
    model,
    tools,
    run,
    clock,
    ids,
    controller,
    append,
    execute,
    request,
    lastUsage,
    read: () => items.read(sessionId),
    kinds: async () => (await items.read(sessionId)).map(item => item.kind),
  };
}

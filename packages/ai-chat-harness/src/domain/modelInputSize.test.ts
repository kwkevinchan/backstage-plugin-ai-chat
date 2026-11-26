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
  agent,
  agentSays,
  budget,
  call,
  log,
  result,
  summary,
  tool,
  user,
} from './fixtures';
import {
  buildModelInput,
  buildSummaryInput,
  estimateTokens,
  modelInputOf,
  planSummary,
  sizeOfModelInput,
  trimmedPartsOf,
  UNTRUSTED_OUTPUT_NOTICE,
} from './modelInput';

describe('modelInputOf (O-01)', () => {
  const extra = {
    context: ['The current plan: none.'],
    tools: [tool({ id: 'catalog:read' })],
  };

  it('gives the input and the trimmed parts of buildModelInput and trimmedPartsOf', () => {
    const items = log(user('one'), agentSays('two'), user('three'));
    const made = modelInputOf(items, agent, extra, budget);
    expect(made.input).toEqual(buildModelInput(items, agent, extra, budget));
    expect(made.trimmed).toEqual(trimmedPartsOf(items, agent, extra, budget));
  });

  it('splits the system prompt into the one of the agent and the context of the step', () => {
    const items = log(user('one'));
    const { size, input } = modelInputOf(items, agent, extra, budget);
    expect(size.parts.system).toBe(
      estimateTokens(`${agent.systemPrompt}\n\n${UNTRUSTED_OUTPUT_NOTICE}`),
    );
    expect(size.parts.system + size.parts.context).toBe(
      estimateTokens(input.system),
    );
    expect(size.parts.tools).toBe(estimateTokens(JSON.stringify(extra.tools)));
    expect(size.parts.history).toBe(estimateTokens('one'));
  });

  it('counts the summary apart from the history and says the input starts with one', () => {
    const items = log(
      user('old'),
      agentSays('old answer'),
      summary(2),
      user('new'),
    );
    const { size } = modelInputOf(items, agent, extra, budget);
    expect(size.summarized).toBe(true);
    expect(size.parts.summary).toBeGreaterThan(estimateTokens('summary'));
    expect(size.parts.history).toBe(estimateTokens('new'));
    expect(size.messages).toBe(1);
  });

  it('stays within the budget it reports when old steps are left out', () => {
    const bodies = [user('first question')];
    for (let i = 1; i <= 8; i++) {
      bodies.push(
        agentSays(`looking at ${i}`),
        call(`c${i}`, { step: i }),
        result(`c${i}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
      );
    }
    bodies.push(user('next question'));
    const small = { tokenBudget: 700, keepRecentSteps: 2 };
    const { size } = modelInputOf(log(...bodies), agent, extra, small);
    expect(size.trimmed).toEqual(['earlier']);
    expect(size.budgetTokens).toBe(700);
    expect(size.estimatedTokens).toBeLessThanOrEqual(700);
  });

  it('sizes the request of a summary', () => {
    const bodies = [user('first question')];
    for (let i = 1; i <= 8; i++) {
      bodies.push(
        agentSays(`looking at ${i}`),
        call(`c${i}`, { step: i }),
        result(`c${i}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
      );
    }
    bodies.push(user('next question'));
    const small = { tokenBudget: 700, keepRecentSteps: 2 };
    const plan = planSummary(log(...bodies), agent, extra, small);
    expect(plan).toBeDefined();
    const input = buildSummaryInput(plan!, small);
    const size = sizeOfModelInput(input, small);
    expect(size).toMatchObject({
      parts: {
        system: estimateTokens(input.system),
        context: 0,
        tools: estimateTokens('[]'),
        summary: 0,
        history: estimateTokens(input.messages[0].content),
        images: 0,
      },
      messages: 1,
      tools: 0,
      summarized: false,
      trimmed: [],
    });
  });
});

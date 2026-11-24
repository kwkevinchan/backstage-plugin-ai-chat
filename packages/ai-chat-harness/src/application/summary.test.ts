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
  estimateTokens,
  LeaseLost,
  SUMMARY_PROMPT,
  type Item,
  type ItemBody,
  type ModelInput,
} from '../domain';
import { agentSays, call, result, tool, user } from '../domain/fixtures';
import { callTool, say, waitForAbort } from '../testing';
import { kit } from '../testing/fixture';
import type { FakeTool } from '../testing';
import type { HarnessEvent } from './events';

const readTool: FakeTool = {
  descriptor: tool({ id: 'catalog:get-entity', readOnly: true }),
  execute: () => ({ status: 'ok', output: { name: 'service-a' } }),
};

const budget = { tokenBudget: 700, keepRecentSteps: 2 };

// A question, `count` steps with a big output each, and a new question.
function longSession(count: number, from = 1): ItemBody[] {
  const bodies: ItemBody[] = [];
  if (from === 1) bodies.push(user('first question'));
  for (let i = from; i < from + count; i++) {
    bodies.push(
      agentSays(`looking at ${i}`),
      call(`c${i}`, { step: i }),
      result(`c${i}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
    );
  }
  bodies.push(user(`question after step ${from + count - 1}`));
  return bodies;
}

const sizeOf = (input: ModelInput) =>
  estimateTokens(input.system) +
  estimateTokens(JSON.stringify(input.tools)) +
  input.messages.reduce(
    (sum, m) =>
      sum +
      estimateTokens(m.content) +
      (m.role === 'assistant'
        ? estimateTokens(JSON.stringify(m.toolCalls))
        : 0),
    0,
  );

const types = (events: HarnessEvent[]) => events.map(e => e.type);

function expectPaired(input: ModelInput) {
  input.messages.forEach((message, i) => {
    if (message.role === 'tool') {
      expect(input.messages[i - 1]?.role).toMatch(/assistant|tool/);
    }
    if (message.role === 'assistant') {
      const ids = message.toolCalls.map(c => c.callId);
      const answers = input.messages
        .slice(i + 1, i + 1 + ids.length)
        .map(m => (m.role === 'tool' ? m.callId : undefined));
      expect(answers).toEqual(ids);
    }
  });
}

describe('AdvanceRun: the context budget (H-09)', () => {
  it('summarizes the old steps before the model call that needs it, and the answer follows', async () => {
    const t = await kit({
      script: [[say('The summary.')], [say('The answer.')]],
      tools: [readTool],
      budget,
      log: longSession(8),
    });
    const { events, outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });

    const log = await t.read();
    const summary = log.find(item => item.kind === 'summary');
    expect(summary).toMatchObject({
      kind: 'summary',
      text: 'The summary.',
      runId: 'run-1',
    });
    expect(log.map(item => item.kind).slice(-2)).toEqual([
      'summary',
      'agent_message',
    ]);

    // The summary goes before the step it serves, and is not a step.
    expect(types(events)).toEqual([
      'run.started',
      'summary.started',
      'item.completed',
      'step.started',
      'item.started',
      'item.delta',
      'item.completed',
      'step.ended',
      'run.ended',
    ]);
    expect(events[1]).toEqual({
      type: 'summary.started',
      coversUpToSeq: (summary as Extract<Item, { kind: 'summary' }>)
        .coversUpToSeq,
    });
    expect(events[2]).toMatchObject({ item: { kind: 'summary' } });
    expect(events[3]).toEqual({ type: 'step.started', step: 9 });
    expect(t.lastUsage().stepsUsed).toBe(9);
  });

  it('covers the old steps and leaves the newest ones out of the summary', async () => {
    const t = await kit({
      script: [[say('The summary.')], [say('The answer.')]],
      tools: [readTool],
      budget,
      log: longSession(8),
    });
    await t.execute();
    const log = await t.read();
    const summary = log.find(item => item.kind === 'summary') as Extract<
      Item,
      { kind: 'summary' }
    >;
    // Items: 1 question, 3 per step (step n starts at seq 3n-1), seq 26 is the
    // new question. The newest two steps (7 and 8) start at 20.
    expect(summary.coversUpToSeq).toBe(19);
  });

  it('asks the model for the summary with the old steps, no tools, and the signal of the run', async () => {
    const t = await kit({
      script: [[say('The summary.')], [say('The answer.')]],
      tools: [readTool],
      budget,
      log: longSession(8),
    });
    await t.execute();
    const request = t.model.inputs[0];
    expect(request.system).toBe(SUMMARY_PROMPT);
    expect(request.tools).toEqual([]);
    const text = request.messages[0].content;
    // The text is cut to the budget: the newest of the old steps stay.
    expect(text).toContain('[The earlier part is left out.]');
    expect(text).toContain('Agent called catalog:get-entity');
    expect(text).toContain('looking at 6');
    // The newest steps are not in it.
    expect(text).not.toContain('looking at 7');
  });

  it('sends the summary and the newest steps, within the budget, with calls and results paired', async () => {
    const t = await kit({
      script: [[say('The summary.')], [say('The answer.')]],
      tools: [readTool],
      budget,
      log: longSession(8),
    });
    await t.execute();
    const input = t.model.inputs[1];
    expect(sizeOf(input)).toBeLessThanOrEqual(budget.tokenBudget);
    expect(input.messages[0].role).toBe('user');
    expect(input.messages[0].content).toContain('The summary.');
    const calls = input.messages.flatMap(m =>
      m.role === 'assistant' ? m.toolCalls.map(c => c.callId) : [],
    );
    expect(calls).toEqual(['c7', 'c8']);
    // The newest steps are whole: their outputs are there.
    const outputs = input.messages
      .filter(m => m.role === 'tool')
      .map(m => JSON.parse(m.content).output?.text?.length);
    expect(outputs).toEqual([800, 800]);
    expect(input.messages[input.messages.length - 1]).toEqual({
      role: 'user',
      content: 'question after step 8',
    });
    expect(input.messages.join('')).not.toContain('looking at 3');
    expectPaired(input);
  });

  it('does not change the items that are already in the log (A-05)', async () => {
    const t = await kit({
      script: [[say('The summary.')], [say('The answer.')]],
      tools: [readTool],
      budget,
      log: longSession(8),
    });
    const before = await t.read();
    await t.execute();
    const after = await t.read();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map(i => i.kind)).toEqual([
      'summary',
      'agent_message',
    ]);
  });

  it('does nothing about the budget while the input fits', async () => {
    const t = await kit({
      script: [[say('The answer.')]],
      tools: [readTool],
      budget: { tokenBudget: 100_000, keepRecentSteps: 2 },
      log: longSession(8),
    });
    const { events } = await t.execute();
    expect(types(events)).not.toContain('summary.started');
    expect(t.model.inputs).toHaveLength(1);
    expect((await t.kinds()).includes('summary')).toBe(false);
  });

  it('shortens the old outputs and writes no summary when that is enough', async () => {
    const t = await kit({
      script: [[say('The answer.')]],
      tools: [readTool],
      // The whole log is about 2000 tokens; shortening the old outputs saves
      // more than the 300 that are over.
      budget: { tokenBudget: 1700, keepRecentSteps: 2 },
      log: longSession(8),
    });
    await t.execute();
    expect(t.model.inputs).toHaveLength(1);
    expect((await t.kinds()).includes('summary')).toBe(false);
    const outputs = t.model.inputs[0].messages
      .filter(m => m.role === 'tool')
      .map(m => JSON.parse(m.content).output === undefined);
    expect(outputs[0]).toBe(true);
    expect(outputs[outputs.length - 1]).toBe(false);
  });

  it('adds to the summary as the session grows: the new one includes the earlier text', async () => {
    const t = await kit({
      script: [
        [say('First summary.')],
        [say('Answer one.')],
        [say('Second summary.')],
        [say('Answer two.')],
      ],
      tools: [readTool],
      budget,
      limits: { maxSteps: 100 },
      log: longSession(8),
    });
    await t.execute();
    const first = (await t.read()).filter(i => i.kind === 'summary');
    expect(first).toHaveLength(1);

    await t.append(...longSession(6, 9));
    await t.execute({ stepsUsed: 0, toolCallsUsed: 0, elapsedSeconds: 0 });
    const summaries = (await t.read()).filter(
      (i): i is Extract<Item, { kind: 'summary' }> => i.kind === 'summary',
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[1].coversUpToSeq).toBeGreaterThan(
      (first[0] as Extract<Item, { kind: 'summary' }>).coversUpToSeq,
    );
    // The first summary item is as it was.
    expect(summaries[0]).toEqual(first[0]);
    const request = t.model.inputs[2];
    expect(request.messages[0].content).toContain(
      'Summary so far:\nFirst summary.',
    );
    expect(t.model.inputs[3].messages[0].content).toContain('Second summary.');
    expect(t.model.inputs[3].messages[0].content).not.toContain(
      'First summary.',
    );
  });

  it('summarizes again inside a run when the steps of the run fill the budget', async () => {
    const t = await kit({
      script: [
        [say('Summary one.')],
        [callTool('m1', 'catalog:get-entity')],
        [callTool('m2', 'catalog:get-entity')],
        [say('Summary two.')],
        [say('Answer.')],
      ],
      tools: [
        {
          ...readTool,
          execute: () => ({ status: 'ok', output: { text: 'r'.repeat(1000) } }),
        },
      ],
      budget: { tokenBudget: 650, keepRecentSteps: 2 },
      limits: { maxSteps: 100 },
      log: longSession(8),
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    const summaries = (await t.read()).filter(
      (i): i is Extract<Item, { kind: 'summary' }> => i.kind === 'summary',
    );
    expect(summaries.map(s => s.text)).toEqual([
      'Summary one.',
      'Summary two.',
    ]);
    expect(summaries[1].coversUpToSeq).toBeGreaterThan(
      summaries[0].coversUpToSeq,
    );
    expect(t.model.inputs[3].messages[0].content).toContain(
      'Summary so far:\nSummary one.',
    );
    const last = t.model.inputs[4];
    expect(last.messages[0].content).toContain('Summary two.');
    expect(last.messages[0].content).not.toContain('Summary one.');
    expectPaired(last);
  });

  describe('when the summary does not come', () => {
    it('goes on without it when the model call fails, and leaves the old steps out', async () => {
      const failure = new Error('provider down');
      const t = await kit({
        script: [failure, [say('The answer.')]],
        tools: [readTool],
        budget,
        log: longSession(8),
      });
      const { events, outcome } = await t.execute();
      expect(outcome).toEqual({ status: 'completed' });
      expect(events).toContainEqual({ type: 'summary.failed', cause: failure });
      expect(await t.kinds()).not.toContain('summary');
      const input = t.model.inputs[1];
      expect(sizeOf(input)).toBeLessThanOrEqual(budget.tokenBudget);
      expect(input.messages[input.messages.length - 1].content).toBe(
        'question after step 8',
      );
      expectPaired(input);
    });

    it('does not try the summary again in the same run after it failed', async () => {
      const t = await kit({
        script: [
          new Error('provider down'),
          [
            {
              type: 'tool_call',
              modelCallId: 'm1',
              toolId: 'catalog:get-entity',
              input: {},
            },
          ],
          [say('The answer.')],
        ],
        tools: [
          {
            ...readTool,
            execute: () => ({
              status: 'ok',
              output: { text: 'r'.repeat(800) },
            }),
          },
        ],
        budget,
        log: longSession(8),
      });
      const { events, outcome } = await t.execute();
      expect(outcome).toEqual({ status: 'completed' });
      expect(types(events).filter(e => e === 'summary.started')).toHaveLength(
        1,
      );
      expect(t.model.inputs).toHaveLength(3);
    });

    it('treats an answer with no text as a failed summary', async () => {
      const t = await kit({
        script: [[say('   ')], [say('The answer.')]],
        tools: [readTool],
        budget,
        log: longSession(8),
      });
      const { events, outcome } = await t.execute();
      expect(outcome).toEqual({ status: 'completed' });
      expect(events).toContainEqual({ type: 'summary.failed' });
      expect(await t.kinds()).not.toContain('summary');
    });

    it('ends as cancelled when the user stops during the summary, and writes nothing', async () => {
      const t = await kit({
        script: [waitForAbort],
        tools: [readTool],
        budget,
        log: longSession(8),
      });
      const before = await t.read();
      setTimeout(() => t.controller.abort(), 20);
      const { events, outcome } = await t.execute();
      expect(outcome).toEqual({ status: 'cancelled' });
      expect(types(events)).toEqual([
        'run.started',
        'summary.started',
        'run.ended',
      ]);
      expect(await t.read()).toEqual(before);
      expect(t.lastUsage().stepsUsed).toBe(8);
    });

    it('ends as timeout when the deadline comes during the summary, and writes nothing', async () => {
      const t = await kit({
        script: [waitForAbort],
        tools: [readTool],
        budget,
        limits: { runTimeoutSeconds: 0.05 },
        log: longSession(8),
      });
      const before = await t.read();
      const { events, outcome } = await t.execute();
      expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
      expect(events.map(e => e.type)).not.toContain('summary.failed');
      expect(events[events.length - 1]).toEqual({ type: 'run.ended', outcome });
      expect(await t.read()).toEqual(before);
    });

    it('throws LeaseLost out of the loop when the summary cannot be written', async () => {
      const t = await kit({
        script: [[say('The summary.')]],
        tools: [readTool],
        budget,
        log: longSession(8),
      });
      await expect(
        t.execute(undefined, { runId: 'run-1', leaseOwner: 'someone-else' }),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect(await t.kinds()).not.toContain('summary');
    });
  });

  describe('a session of 500 items', () => {
    it('reads only what the summary does not cover, and builds the input from that', async () => {
      const t = await kit({
        script: [[say('The answer.')]],
        tools: [readTool],
        budget: { tokenBudget: 100_000, keepRecentSteps: 2 },
        limits: { maxSteps: 1000 },
        log: [
          ...longSession(166),
          { kind: 'summary', coversUpToSeq: 481, text: 'Everything before.' },
          ...longSession(5, 167),
        ],
      });
      const total = (await t.read()).length;
      expect(total).toBe(1 + 166 * 3 + 1 + 1 + 5 * 3 + 1);

      const reads: number[] = [];
      const original = t.items.read.bind(t.items);
      t.items.read = async (...args) => {
        const items = await original(...args);
        reads.push(items.length);
        return items;
      };
      await t.execute();
      // Every read of the loop returns the part after the summary only.
      expect(reads.length).toBeGreaterThan(0);
      expect(Math.max(...reads)).toBeLessThan(total / 5);
      expect(t.model.inputs[0].messages[0].content).toContain(
        'Everything before.',
      );
    });
  });
});

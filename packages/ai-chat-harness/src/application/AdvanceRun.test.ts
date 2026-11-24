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

import { LeaseLost, type ItemBody } from '../domain';
import { approve, call, result, started, tool } from '../domain/fixtures';
import type { HarnessEvent } from './events';
import { callTool, say, waitForAbort } from '../testing';
import type { FakeTool } from '../testing';
import { kit, fence, sessionId } from '../testing/fixture';
import { executeTools } from './steps/executeTools';

const readTool: FakeTool = {
  descriptor: tool({ id: 'catalog:get-entity', readOnly: true }),
  execute: () => ({ status: 'ok', output: { name: 'service-a' } }),
};
const writeTool: FakeTool = {
  descriptor: tool({ id: 'temporal:start-workflow', readOnly: false }),
  execute: () => ({ status: 'ok', output: { started: true } }),
};

const toolMessages = (input: { messages: { role: string }[] }) =>
  input.messages.filter(m => m.role === 'tool') as {
    role: 'tool';
    callId: string;
    content: string;
  }[];

const approval = (callId: string, decision: 'allow' | 'deny' = 'allow') =>
  approve(callId, decision) as ItemBody;

describe('AdvanceRun: an answer', () => {
  it('reports the run, the step and the text in order, and writes one agent_message', async () => {
    const t = await kit({ script: [[say('Hel'), say('lo')]] });
    const { events, outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(events.map(e => e.type)).toEqual([
      'run.started',
      'step.started',
      'item.started',
      'item.delta',
      'item.delta',
      'item.completed',
      'step.ended',
      'run.ended',
    ]);
    expect(events[0]).toEqual({ type: 'run.started', runId: 'run-1' });
    expect(events[1]).toEqual({ type: 'step.started', step: 1 });
    const draft = events[2] as { draftId: string; kind: string };
    expect(draft.kind).toBe('agent_message');
    expect(events.slice(3, 5)).toEqual([
      { type: 'item.delta', draftId: draft.draftId, text: 'Hel' },
      { type: 'item.delta', draftId: draft.draftId, text: 'lo' },
    ]);
    expect(events[5]).toMatchObject({
      type: 'item.completed',
      draftId: draft.draftId,
      item: { kind: 'agent_message', text: 'Hello', seq: 2 },
    });
    expect(events[7]).toEqual({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    expect(await t.kinds()).toEqual(['user_message', 'agent_message']);
  });

  it('sends the user message and the system prompt to the model', async () => {
    const t = await kit({ script: [[say('ok')]] });
    await t.execute();
    expect(t.model.inputs).toHaveLength(1);
    expect(t.model.inputs[0].messages).toEqual([
      { role: 'user', content: 'question' },
    ]);
    expect(t.model.inputs[0].system).toContain('You are a helpful agent.');
  });

  it('does not call the model when the log already ends with the answer', async () => {
    const t = await kit({
      script: [],
      log: [
        { kind: 'user_message', text: 'q' },
        { kind: 'agent_message', text: 'a' },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.model.inputs).toHaveLength(0);
  });

  it('records the usage after the run', async () => {
    const t = await kit({ script: [[say('ok')]] });
    await t.execute();
    expect(t.run.usage[t.run.usage.length - 1]).toEqual({
      stepsUsed: 1,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    });
  });
});

describe('AdvanceRun: events and the log (A-03)', () => {
  it('writes every item.completed to the log, in order, and nothing of the deltas', async () => {
    const t = await kit({
      script: [
        [say('Let me '), say('check.'), callTool('m1', 'catalog:get-entity')],
        [say('Done.')],
      ],
      tools: [readTool],
    });
    const { events } = await t.execute();
    const log = await t.read();

    const completed = events.flatMap(e =>
      e.type === 'item.completed' ? [e.item] : [],
    );
    // The user message was written before the run; everything after it is
    // reported exactly once.
    expect(completed).toEqual(log.slice(1));
    const deltas = events.filter(e => e.type === 'item.delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(log.map(i => i.kind)).toEqual([
      'user_message',
      'agent_message',
      'tool_call',
      'tool_result',
      'agent_message',
    ]);
    // The partial text is not an item of its own.
    expect(log.filter(i => i.kind === 'agent_message')).toHaveLength(2);
  });

  it('reports the items of a step before step.ended, and the results after it', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('Done.')]],
      tools: [readTool],
    });
    const { events } = await t.execute();
    const order = events.map(e =>
      e.type === 'item.completed' ? `completed:${e.item.kind}` : e.type,
    );
    expect(order).toEqual([
      'run.started',
      'step.started',
      'item.started',
      'completed:tool_call',
      'step.ended',
      'completed:tool_result',
      'step.started',
      'item.started',
      'item.delta',
      'completed:agent_message',
      'step.ended',
      'run.ended',
    ]);
  });
});

describe('AdvanceRun: the items of a step (agreement 3)', () => {
  it('writes the text and the calls of a step in one append, text first', async () => {
    const t = await kit({
      script: [
        [
          say('I will look.'),
          callTool('m1', 'catalog:get-entity'),
          callTool('m2', 'catalog:get-entity'),
        ],
        [say('done')],
      ],
      tools: [readTool],
    });
    const append = jest.spyOn(t.items, 'append');
    await t.execute();
    const first = append.mock.calls[0][1].map(draft => draft.kind);
    expect(first).toEqual(['agent_message', 'tool_call', 'tool_call']);
    const log = await t.read();
    expect(log.slice(1, 4).map(i => i.seq)).toEqual([2, 3, 4]);
  });

  it('does not write an agent_message for a blank answer', async () => {
    const t = await kit({
      script: [
        [say('  '), say('\n'), callTool('m1', 'catalog:get-entity')],
        [say('ok')],
      ],
      tools: [readTool],
    });
    const { events } = await t.execute();
    const log = await t.read();
    expect(log.map(i => i.kind)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'agent_message',
    ]);
    // Blank text is not even reported as an item.
    expect(
      events.filter(
        e => e.type === 'item.started' && e.kind === 'agent_message',
      ),
    ).toHaveLength(1);
  });

  it('keeps leading blank text in the message once there is real text', async () => {
    const t = await kit({ script: [[say(' '), say('hi')]] });
    const { events } = await t.execute();
    expect(events.filter(e => e.type === 'item.delta')).toEqual([
      expect.objectContaining({ text: ' hi' }),
    ]);
    expect((await t.read())[1]).toMatchObject({ text: ' hi' });
  });

  it('fails the run for an answer with no text and no call, and writes nothing', async () => {
    const t = await kit({ script: [[say('')]] });
    const { outcome, events } = await t.execute();
    expect(outcome).toEqual({
      status: 'failed',
      message: 'The model gave no answer.',
    });
    expect(events[events.length - 1]).toEqual({ type: 'run.ended', outcome });
    expect(await t.kinds()).toEqual(['user_message']);
  });
});

describe('AdvanceRun: call ids (agreement 1)', () => {
  it('gives each call an id of its own, not the id of the model, and maps it back', async () => {
    const t = await kit({
      script: [[callTool('call_0', 'catalog:get-entity')], [say('ok')]],
      tools: [readTool],
    });
    const { events } = await t.execute();
    const log = await t.read();
    const toolCall = log.find(i => i.kind === 'tool_call');
    if (toolCall?.kind !== 'tool_call') throw new Error('no tool_call');

    expect(toolCall.callId).not.toBe('call_0');
    expect(toolCall.callId).toMatch(/^call-\d+$/);
    // The draft id is the call id of the log; the id of the model is a field.
    expect(events).toContainEqual({
      type: 'item.started',
      draftId: toolCall.callId,
      kind: 'tool_call',
      modelCallId: 'call_0',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'item.completed',
        draftId: toolCall.callId,
        item: expect.objectContaining({ callId: toolCall.callId }),
      }),
    );
    // The model sees the call id of the log, in the call and in its answer.
    const second = t.model.inputs[1];
    const assistant = second.messages.find(m => m.role === 'assistant');
    expect(assistant).toMatchObject({
      toolCalls: [{ callId: toolCall.callId }],
    });
    expect(toolMessages(second).map(m => m.callId)).toEqual([toolCall.callId]);
  });

  it('survives a model that reuses its call ids in every step', async () => {
    const t = await kit({
      script: [
        [callTool('call_0', 'catalog:get-entity')],
        [callTool('call_0', 'catalog:get-entity')],
        [say('ok')],
      ],
      tools: [readTool],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    const ids = (await t.read()).flatMap(i =>
      i.kind === 'tool_call' ? [i.callId] : [],
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('takes the call ids from the IdGenerator', async () => {
    const t = await kit({
      script: [
        [
          callTool('x', 'catalog:get-entity'),
          callTool('y', 'catalog:get-entity'),
        ],
        [say('ok')],
      ],
      tools: [readTool],
    });
    await t.execute();
    const ids = (await t.read()).flatMap(i =>
      i.kind === 'tool_call' ? [i.callId] : [],
    );
    // One id went to the draft of the text (none here), the others to calls.
    expect(ids).toEqual(['call-1', 'call-2']);
  });
});

describe('AdvanceRun: read-only tools', () => {
  it('runs the tool at once and shows the model the result', async () => {
    const t = await kit({
      script: [
        [callTool('m1', 'catalog:get-entity', { entityRef: 'component:a' })],
        [say('It is service-a.')],
      ],
      tools: [readTool],
    });
    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(1);
    expect(t.tools.executed[0]).toMatchObject({
      toolId: 'catalog:get-entity',
      input: { entityRef: 'component:a' },
    });
    const log = await t.read();
    expect(log.map(i => i.kind)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'agent_message',
    ]);
    expect(log[1]).toMatchObject({
      policy: 'allow',
      readOnly: true,
      step: 1,
      position: 0,
    });
    expect(log[2]).toMatchObject({
      status: 'ok',
      output: { name: 'service-a' },
    });
    const [message] = toolMessages(t.model.inputs[1]);
    expect(JSON.parse(message.content)).toMatchObject({
      status: 'ok',
      output: { name: 'service-a' },
    });
  });

  it('writes no tool_started for a read-only tool', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [readTool],
    });
    await t.execute();
    expect(await t.kinds()).not.toContain('tool_started');
  });

  it('turns an exception of the tool into an error result and goes on', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('sorry')]],
      tools: [
        {
          ...readTool,
          execute: () => {
            throw new Error('backend down');
          },
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect((await t.read())[2]).toMatchObject({
      kind: 'tool_result',
      status: 'error',
      message: 'backend down',
    });
  });

  it('writes the result a tool gives with its status, truncation and message', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [
        {
          ...readTool,
          execute: () => ({
            status: 'timeout',
            truncated: true,
            message: 'too slow',
          }),
        },
      ],
    });
    await t.execute();
    expect((await t.read())[2]).toMatchObject({
      status: 'timeout',
      truncated: true,
      message: 'too slow',
    });
  });

  it('runs the calls of one step in the order of their position', async () => {
    const order: string[] = [];
    const t = await kit({
      script: [
        [
          callTool('m1', 'catalog:get-entity', { n: 1 }),
          callTool('m2', 'catalog:get-entity', { n: 2 }),
          callTool('m3', 'catalog:get-entity', { n: 3 }),
        ],
        [say('ok')],
      ],
      tools: [
        {
          ...readTool,
          execute: c => {
            order.push(String(c.input.n));
            return { status: 'ok', output: {} };
          },
        },
      ],
    });
    await t.execute();
    expect(order).toEqual(['1', '2', '3']);
    const results = (await t.read()).flatMap(i =>
      i.kind === 'tool_result' ? [i.callId] : [],
    );
    expect(results).toEqual(['call-1', 'call-2', 'call-3']);
  });
});

describe('AdvanceRun: tools that need approval', () => {
  const script = [
    [
      say('I will start it.'),
      callTool('m1', 'temporal:start-workflow', { id: 'w1' }),
    ],
    [say('Started.')],
  ];

  it('waits, and runs the tool once after the approval', async () => {
    const t = await kit({ script, tools: [writeTool] });
    const first = await t.execute();

    expect(first.outcome).toMatchObject({
      status: 'waiting_approval',
      pending: [{ toolId: 'temporal:start-workflow', callId: 'call-2' }],
    });
    expect(first.events[first.events.length - 1]).toEqual({
      type: 'run.ended',
      outcome: first.outcome,
    });
    expect(t.tools.executed).toHaveLength(0);
    expect(await t.kinds()).toEqual([
      'user_message',
      'agent_message',
      'tool_call',
    ]);

    await t.append(approval('call-2'));
    const second = await t.execute();
    expect(second.outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(1);
    expect(await t.kinds()).toEqual([
      'user_message',
      'agent_message',
      'tool_call',
      'approval',
      'tool_started',
      'tool_result',
      'agent_message',
    ]);

    // Another call of the loop does nothing more.
    const third = await t.execute();
    expect(third.outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(1);
    expect(t.model.inputs).toHaveLength(2);
  });

  it('writes tool_started before the tool runs and the result after it (D-25)', async () => {
    const seen: string[][] = [];
    const t = await kit({
      script,
      tools: [
        {
          ...writeTool,
          execute: async () => {
            seen.push(await t.kinds());
            return { status: 'ok', output: {} };
          },
        },
      ],
    });
    await t.execute();
    await t.append(approval('call-2'));
    await t.execute();
    expect(seen).toHaveLength(1);
    expect(seen[0][seen[0].length - 1]).toBe('tool_started');
    expect(seen[0]).not.toContain('tool_result');
  });

  it('asks for a tool that is not read-only even when the settings say allow (agreement 2)', async () => {
    const t = await kit({
      script,
      tools: [writeTool],
      policy: { byTool: { 'temporal:start-workflow': 'allow' } },
    });
    const { outcome } = await t.execute();
    expect(outcome.status).toBe('waiting_approval');
    expect((await t.read())[2]).toMatchObject({
      policy: 'ask',
      readOnly: false,
    });
    expect(t.tools.executed).toHaveLength(0);
  });

  it('asks for a read-only tool that the settings say ask for, and for one that sends data out', async () => {
    const egress: FakeTool = {
      descriptor: tool({ id: 'web:fetch', readOnly: true, egress: true }),
    };
    const t = await kit({
      script: [
        [callTool('m1', 'catalog:get-entity'), callTool('m2', 'web:fetch')],
      ],
      tools: [readTool, egress],
      policy: { byTool: { 'catalog:get-entity': 'ask' } },
    });
    const { outcome } = await t.execute();
    expect(outcome).toMatchObject({
      status: 'waiting_approval',
      pending: [{ toolId: 'catalog:get-entity' }, { toolId: 'web:fetch' }],
    });
    expect(
      (await t.read())
        .filter(i => i.kind === 'tool_call')
        .map(i => (i as { policy: string }).policy),
    ).toEqual(['ask', 'ask']);
  });

  it('records a read-only tool with the policy allow', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [readTool],
    });
    await t.execute();
    expect((await t.read())[1]).toMatchObject({
      policy: 'allow',
      readOnly: true,
    });
  });

  describe('two calls that need approval (P-04)', () => {
    const twoCalls = [
      [
        callTool('m1', 'temporal:start-workflow', { id: 'w1' }),
        callTool('m2', 'temporal:start-workflow', { id: 'w2' }),
      ],
      [say('Both started.')],
    ];

    it('stays waiting when only one is decided, and runs nothing', async () => {
      const t = await kit({ script: twoCalls, tools: [writeTool] });
      await t.execute();
      await t.append(approval('call-1'));
      const { outcome } = await t.execute();
      expect(outcome).toMatchObject({
        status: 'waiting_approval',
        pending: [{ callId: 'call-2' }],
      });
      expect(t.tools.executed).toHaveLength(0);
    });

    it('runs the allowed ones in order once every call is decided', async () => {
      const t = await kit({ script: twoCalls, tools: [writeTool] });
      await t.execute();
      await t.append(approval('call-2', 'allow'));
      await t.execute();
      await t.append(approval('call-1', 'allow'));
      const { outcome } = await t.execute();
      expect(outcome).toEqual({ status: 'completed' });
      expect(t.tools.executed.map(c => c.callId)).toEqual(['call-1', 'call-2']);
    });
  });

  describe('a denied call', () => {
    it('writes a denied result, does not run the tool, and the model gets it', async () => {
      const t = await kit({ script, tools: [writeTool] });
      await t.execute();
      await t.append(approval('call-2', 'deny'));
      const { outcome } = await t.execute();

      expect(outcome).toEqual({ status: 'completed' });
      expect(t.tools.executed).toHaveLength(0);
      const log = await t.read();
      expect(log.map(i => i.kind)).not.toContain('tool_started');
      expect(log.find(i => i.kind === 'tool_result')).toMatchObject({
        callId: 'call-2',
        status: 'denied',
      });
      const [message] = toolMessages(t.model.inputs[1]);
      expect(JSON.parse(message.content)).toMatchObject({ status: 'denied' });
    });

    it('denies one and runs the other', async () => {
      const t = await kit({
        script: [
          [
            callTool('m1', 'temporal:start-workflow', { id: 'w1' }),
            callTool('m2', 'temporal:start-workflow', { id: 'w2' }),
          ],
          [say('ok')],
        ],
        tools: [writeTool],
      });
      await t.execute();
      await t.append(approval('call-1', 'deny'), approval('call-2', 'allow'));
      await t.execute();
      expect(t.tools.executed.map(c => c.callId)).toEqual(['call-2']);
    });
  });
});

describe('AdvanceRun: a call that is refused when it is written', () => {
  it('answers input that fails the schema with invalid, asks for no approval, and tells the model (T-05)', async () => {
    const t = await kit({
      script: [
        [callTool('m1', 'temporal:start-workflow', { id: 5 })],
        [say('I will fix the input.')],
      ],
      tools: [
        {
          ...writeTool,
          validate: () => ({ valid: false, message: 'id must be a string' }),
        },
      ],
    });
    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(0);
    const log = await t.read();
    expect(log.map(i => i.kind)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'agent_message',
    ]);
    expect(log[2]).toMatchObject({
      status: 'invalid',
      message: 'id must be a string',
    });
    const [message] = toolMessages(t.model.inputs[1]);
    expect(JSON.parse(message.content)).toMatchObject({
      status: 'invalid',
      message: 'id must be a string',
    });
  });

  it('validates the input the model gave', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity', { a: 1 })], [say('ok')]],
      tools: [readTool],
    });
    await t.execute();
    expect(t.tools.validated).toEqual([
      { toolId: 'catalog:get-entity', input: { a: 1 } },
    ]);
  });

  it.each<[string, unknown, string]>([
    ['a string', 'text', 'The input must be a JSON object.'],
    ['an array', [1], 'The input must be a JSON object.'],
    ['null', null, 'The input must be a JSON object.'],
  ])('answers input that is %s with invalid', async (_name, input, message) => {
    const t = await kit({
      script: [
        [callTool('m1', 'catalog:get-entity', input as never)],
        [say('ok')],
      ],
      tools: [readTool],
    });
    await t.execute();
    expect(t.tools.validated).toHaveLength(0);
    const log = await t.read();
    expect(log[1]).toMatchObject({ kind: 'tool_call', input: {} });
    expect(log[2]).toMatchObject({ status: 'invalid', message });
  });

  it('answers an unknown tool with invalid', async () => {
    const t = await kit({
      script: [[callTool('m1', 'nothing:here')], [say('ok')]],
      tools: [readTool],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect((await t.read())[2]).toMatchObject({
      status: 'invalid',
      message: 'Unknown tool: nothing:here',
    });
  });

  it('does not offer a tool the policy denies, and denies a call of it (agreement 2)', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [readTool],
      policy: { byTool: { 'catalog:get-entity': 'deny' } },
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.model.inputs[0].tools).toEqual([]);
    expect(t.tools.executed).toHaveLength(0);
    expect((await t.read())[2]).toMatchObject({ status: 'denied' });
  });

  it('offers the other tools to the model', async () => {
    const t = await kit({
      script: [[say('ok')]],
      tools: [readTool, writeTool],
      policy: { byTool: { 'catalog:get-entity': 'deny' } },
    });
    await t.execute();
    expect(t.model.inputs[0].tools.map(x => x.id)).toEqual([
      'temporal:start-workflow',
    ]);
  });
});

describe('AdvanceRun: limits (H-05)', () => {
  const loopForever = Array.from({ length: 20 }, () => [
    callTool('m', 'catalog:get-entity'),
  ]);

  it('stops after the steps are used up', async () => {
    const t = await kit({
      script: loopForever,
      tools: [readTool],
      limits: { maxSteps: 3 },
    });
    const { outcome, events } = await t.execute();
    expect(outcome).toEqual({ status: 'completed', endReason: 'max_steps' });
    expect(events[events.length - 1]).toEqual({ type: 'run.ended', outcome });
    expect(t.model.inputs).toHaveLength(3);
    // The calls of the last step still have their results.
    expect((await t.kinds()).filter(k => k === 'tool_result')).toHaveLength(3);
  });

  it('counts the steps of earlier calls of the loop for the same run', async () => {
    const t = await kit({
      script: loopForever,
      tools: [readTool],
      limits: { maxSteps: 3 },
    });
    const { outcome } = await t.execute({
      stepsUsed: 2,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    });
    expect(outcome).toEqual({ status: 'completed', endReason: 'max_steps' });
    expect(t.model.inputs).toHaveLength(1);
  });

  it('stops when the tool calls are used up', async () => {
    const t = await kit({
      script: loopForever,
      tools: [readTool],
      limits: { maxToolCallsPerRun: 2 },
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({
      status: 'completed',
      endReason: 'max_tool_calls',
    });
    expect(t.tools.executed).toHaveLength(2);
  });

  it('denies the calls of a step beyond the limit with "tool call limit" and does not run them (agreement 4)', async () => {
    const t = await kit({
      script: [
        [
          callTool('m1', 'catalog:get-entity'),
          callTool('m2', 'catalog:get-entity'),
          callTool('m3', 'catalog:get-entity'),
        ],
        [say('ok')],
      ],
      tools: [readTool],
      limits: { maxToolCallsPerRun: 2 },
    });
    const { outcome } = await t.execute();

    expect(t.tools.executed.map(c => c.callId)).toEqual(['call-1', 'call-2']);
    const results = (await t.read()).flatMap(i =>
      i.kind === 'tool_result' ? [i] : [],
    );
    expect(results.map(r => [r.callId, r.status])).toEqual([
      ['call-3', 'denied'],
      ['call-1', 'ok'],
      ['call-2', 'ok'],
    ]);
    expect(results[0].message).toBe('tool call limit');
    // The limit is reached, so the model is not called again.
    expect(outcome).toEqual({
      status: 'completed',
      endReason: 'max_tool_calls',
    });
    expect(t.model.inputs).toHaveLength(1);
  });

  it('counts the calls of earlier steps against the limit', async () => {
    const t = await kit({
      script: [
        [callTool('m1', 'catalog:get-entity')],
        [
          callTool('m2', 'catalog:get-entity'),
          callTool('m3', 'catalog:get-entity'),
        ],
        [say('ok')],
      ],
      tools: [readTool],
      limits: { maxToolCallsPerRun: 2 },
    });
    await t.execute();
    expect(t.tools.executed.map(c => c.callId)).toEqual(['call-1', 'call-2']);
    expect(
      (await t.read()).find(
        i => i.kind === 'tool_result' && i.callId === 'call-3',
      ),
    ).toMatchObject({ status: 'denied', message: 'tool call limit' });
  });

  it('stops when the working time is used up', async () => {
    const t = await kit({
      script: [
        () => {
          t.clock.advance(400);
          return [callTool('m1', 'catalog:get-entity')];
        },
        [say('never')],
      ],
      tools: [readTool],
      limits: { runTimeoutSeconds: 300 },
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
    expect(t.model.inputs).toHaveLength(1);
    expect(t.run.usage[t.run.usage.length - 1].elapsedSeconds).toBe(400);
  });

  it('adds the time of earlier calls of the loop, and not the time between them', async () => {
    const t = await kit({
      script: [[say('never')]],
      tools: [readTool],
      limits: { runTimeoutSeconds: 300 },
    });
    t.clock.advance(10_000);
    const { outcome } = await t.execute({
      stepsUsed: 1,
      toolCallsUsed: 0,
      elapsedSeconds: 300,
    });
    expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
    expect(t.model.inputs).toHaveLength(0);
  });
});

describe('AdvanceRun: stopping (H-06)', () => {
  it('ends before the next step when the heartbeat says the user asked to stop', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('never')]],
      tools: [readTool],
    });
    t.run.cancelAtHeartbeat(2);
    const { outcome, events } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events[events.length - 1]).toEqual({
      type: 'run.ended',
      outcome: { status: 'cancelled' },
    });
    expect(t.model.inputs).toHaveLength(1);
    // The call of the first step was written and keeps no result: it did not run.
    expect(await t.kinds()).toEqual(['user_message', 'tool_call']);
    expect(t.tools.executed).toHaveLength(0);
  });

  it('keeps the results that are done', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('never')]],
      tools: [readTool],
    });
    t.run.cancelAtHeartbeat(3);
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await t.kinds()).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
    ]);
  });

  it('does not call the model when it is asked to stop at once', async () => {
    const t = await kit({ script: [[say('never')]] });
    t.run.cancelAtHeartbeat(1);
    expect((await t.execute()).outcome).toEqual({ status: 'cancelled' });
    expect(t.model.inputs).toHaveLength(0);
  });

  it('ends when the signal aborts while the model answers, and writes nothing of that step', async () => {
    const t = await kit({
      script: [
        () => {
          t.controller.abort();
          return [say('half')];
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await t.kinds()).toEqual(['user_message']);
  });

  it('ends when the signal aborts while a tool runs, and writes no result for it', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('never')]],
      tools: [
        {
          ...readTool,
          execute: () => {
            t.controller.abort();
            throw new Error('aborted');
          },
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await t.kinds()).toEqual(['user_message', 'tool_call']);
  });
});

describe('AdvanceRun: taking over after a crash (A-08, D-25)', () => {
  const crashed = (): ItemBody[] => [
    { kind: 'user_message', text: 'deploy it' },
    call('call-1', {
      policy: 'ask',
      readOnly: false,
      toolId: 'temporal:start-workflow',
    }),
    approval('call-1'),
    started('call-1'),
  ];

  it('does not run a call that started and has no result, and writes unknown', async () => {
    const t = await kit({
      script: [[say('I could not tell.')]],
      tools: [writeTool],
      log: crashed(),
    });
    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(0);
    const log = await t.read();
    expect(log.find(i => i.kind === 'tool_result')).toMatchObject({
      callId: 'call-1',
      status: 'unknown',
    });
    expect(log.filter(i => i.kind === 'tool_started')).toHaveLength(1);
    const [message] = toolMessages(t.model.inputs[0]);
    expect(JSON.parse(message.content)).toMatchObject({ status: 'unknown' });
  });

  it('writes unknown for the interrupted call only, and leaves the finished one as it is', async () => {
    const t = await kit({
      script: [[say('ok')]],
      tools: [writeTool],
      log: [
        { kind: 'user_message', text: 'deploy them' },
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
          position: 0,
        }),
        call('call-2', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
          position: 1,
        }),
        approval('call-1'),
        approval('call-2'),
        started('call-1'),
        result('call-1', 'ok'),
        { kind: 'tool_started', callId: 'call-2' },
      ],
    });
    // call-1 has its result; call-2 started and has none.
    await t.execute();
    expect(t.tools.executed).toHaveLength(0);
    expect((await t.read()).filter(i => i.kind === 'tool_result')).toEqual([
      expect.objectContaining({ callId: 'call-1', status: 'ok' }),
      expect.objectContaining({ callId: 'call-2', status: 'unknown' }),
    ]);
  });
});

describe('AdvanceRun: errors', () => {
  it('ends the run as failed when the model call fails, and keeps the log', async () => {
    const t = await kit({ script: [new Error('503 from the model')] });
    const { outcome, events } = await t.execute();
    // The text for the user is fixed; the text of the provider is the cause.
    expect(outcome).toEqual({
      status: 'failed',
      message: 'The model call failed.',
      cause: new Error('503 from the model'),
    });
    expect(JSON.stringify(events)).not.toContain('503');
    expect(events[events.length - 1]).toEqual({ type: 'run.ended', outcome });
    expect(await t.kinds()).toEqual(['user_message']);
  });

  it('throws LeaseLost out of the loop, with no run.ended', async () => {
    const t = await kit({ script: [[say('x')]] });
    t.items.grantLease(sessionId, { ...fence, leaseOwner: 'backend-b' });
    await expect(t.execute()).rejects.toBeInstanceOf(LeaseLost);
  });
});

describe('executeTools: agreement 5', () => {
  const run = async (
    t: Awaited<ReturnType<typeof kit>>,
    action: Parameters<typeof executeTools>[3],
  ) => {
    const items = await t.read();
    const generator = executeTools(
      {
        items: t.items,
        model: t.model,
        tools: t.tools,
        run: t.run,
        clock: t.clock,
        ids: t.ids,
        extensions: {},
      },
      t.request(),
      items,
      action,
    );
    const events: HarnessEvent[] = [];
    for await (const event of generator) events.push(event);
    return events;
  };
  const callsOf = async (t: Awaited<ReturnType<typeof kit>>) =>
    (await t.read()).flatMap(i => (i.kind === 'tool_call' ? [i] : []));

  it('runs a call only when the decision is allow: not one with no decision', async () => {
    const t = await kit({
      script: [],
      tools: [writeTool],
      log: [
        { kind: 'user_message', text: 'q' },
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
        }),
      ],
    });
    const events = await run(t, { calls: await callsOf(t), interrupted: [] });
    expect(t.tools.executed).toHaveLength(0);
    expect(events).toEqual([]);
    expect(await t.kinds()).toEqual(['user_message', 'tool_call']);
  });

  it('throws for a decision that is neither allow nor deny, and runs nothing', async () => {
    const t = await kit({
      script: [],
      tools: [writeTool],
      log: [
        { kind: 'user_message', text: 'q' },
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
        }),
        { ...approval('call-1'), decision: 'maybe' } as never,
      ],
    });
    await expect(
      run(t, { calls: await callsOf(t), interrupted: [] }),
    ).rejects.toThrow('not allow or deny');
    expect(t.tools.executed).toHaveLength(0);
  });

  it('does not run a denied call', async () => {
    const t = await kit({
      script: [],
      tools: [writeTool],
      log: [
        { kind: 'user_message', text: 'q' },
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
        }),
        approval('call-1', 'deny'),
      ],
    });
    await run(t, { calls: await callsOf(t), interrupted: [] });
    expect(t.tools.executed).toHaveLength(0);
    expect((await t.read())[3]).toMatchObject({ status: 'denied' });
  });

  it('does not run an interrupted call and writes unknown', async () => {
    const t = await kit({
      script: [],
      tools: [writeTool],
      log: [
        { kind: 'user_message', text: 'q' },
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
        }),
        approval('call-1'),
        started('call-1'),
      ],
    });
    const calls = await callsOf(t);
    const events = await run(t, { calls: [], interrupted: calls });
    expect(t.tools.executed).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'item.completed',
        item: expect.objectContaining({
          kind: 'tool_result',
          status: 'unknown',
        }),
      }),
    ]);
  });

  it('writes tool_started for a tool that is not read-only, and only for it', async () => {
    const t = await kit({
      script: [],
      tools: [writeTool, readTool],
      log: [
        { kind: 'user_message', text: 'q' },
        call('call-1', {
          policy: 'allow',
          readOnly: true,
          toolId: 'catalog:get-entity',
          position: 0,
        }),
        call('call-2', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
          position: 1,
        }),
        approval('call-2'),
      ],
    });
    await run(t, { calls: await callsOf(t), interrupted: [] });
    expect(await t.kinds()).toEqual([
      'user_message',
      'tool_call',
      'tool_call',
      'approval',
      'tool_result',
      'tool_started',
      'tool_result',
    ]);
    expect(t.tools.executed.map(c => c.callId)).toEqual(['call-1', 'call-2']);
  });
});

it('uses the session of the context for every write', async () => {
  const t = await kit({ script: [[say('ok')]] });
  await t.execute();
  expect((await t.read()).every(i => i.sessionId === sessionId)).toBe(true);
});

describe('AdvanceRun: tools that give no result', () => {
  it('writes an error result when the tool gives nothing, and does not run it again', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [{ ...readTool, execute: () => undefined as never }],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(1);
    expect((await t.read())[2]).toMatchObject({
      kind: 'tool_result',
      status: 'error',
      message: 'The tool gave no result.',
    });
  });

  it('leaves the call alone when the tool gives nothing because the signal aborted', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('never')]],
      tools: [
        {
          ...readTool,
          execute: () => {
            t.controller.abort();
            return undefined as never;
          },
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await t.kinds()).toEqual(['user_message', 'tool_call']);
  });
});

describe('AdvanceRun: stopping between calls that are not read-only', () => {
  const twoApproved = (): ItemBody[] => [
    { kind: 'user_message', text: 'deploy both' },
    call('call-1', {
      policy: 'ask',
      readOnly: false,
      toolId: 'temporal:start-workflow',
      position: 0,
    }),
    call('call-2', {
      policy: 'ask',
      readOnly: false,
      toolId: 'temporal:start-workflow',
      position: 1,
    }),
    approval('call-1'),
    approval('call-2'),
  ];

  it('does not start the second call when the user asks to stop while the first one runs', async () => {
    const t = await kit({
      script: [[say('never')]],
      tools: [writeTool],
      log: twoApproved(),
    });
    // 1: the round of the loop, 2: before call-1, 3: before call-2.
    t.run.cancelAtHeartbeat(3);
    const { outcome, events } = await t.execute();

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events[events.length - 1]).toEqual({ type: 'run.ended', outcome });
    expect(t.tools.executed.map(c => c.callId)).toEqual(['call-1']);
    const log = await t.read();
    expect(
      log
        .filter(i => i.kind === 'tool_started')
        .map(i => (i as { callId: string }).callId),
    ).toEqual(['call-1']);
    expect(t.model.inputs).toHaveLength(0);
  });

  it('asks before each call that is not read-only, and not before a read-only one', async () => {
    const t = await kit({
      script: [[say('ok')]],
      tools: [writeTool, readTool],
      log: [
        ...twoApproved(),
        call('call-3', { policy: 'allow', readOnly: true, position: 2 }),
      ],
    });
    await t.execute();
    // Three rounds (tools, model call, end) and one for each of the two calls
    // that are not read-only.
    expect(t.run.heartbeats).toBe(3 + 2);
  });

  it('does not run a call whose tool_started was written when the signal aborted after it', async () => {
    const t = await kit({
      script: [[say('never')]],
      tools: [writeTool],
      log: twoApproved(),
    });
    const original = t.items.append.bind(t.items);
    jest.spyOn(t.items, 'append').mockImplementation(async (s, d, f) => {
      const written = await original(s, d, f);
      if (d[0].kind === 'tool_started') t.controller.abort();
      return written;
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(t.tools.executed).toHaveLength(0);
    // Started and no result: a backend that takes over writes unknown.
    expect(await t.kinds()).toEqual([
      'user_message',
      'tool_call',
      'tool_call',
      'approval',
      'approval',
      'tool_started',
    ]);
  });
});

describe('AdvanceRun: the working time inside a step', () => {
  it('ends a model call that is still running at the deadline as timeout, not as cancelled', async () => {
    const t = await kit({
      script: [waitForAbort],
      limits: { runTimeoutSeconds: 0.05 },
    });
    const { outcome, events } = await t.execute();
    expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
    expect(events[events.length - 1]).toEqual({ type: 'run.ended', outcome });
    expect(await t.kinds()).toEqual(['user_message']);
  });

  it('ends a tool that is still running at the deadline as timeout, and writes no result for it', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('never')]],
      tools: [
        {
          ...readTool,
          execute: (_call, { signal }) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new Error('x'))),
            ),
        },
      ],
      limits: { runTimeoutSeconds: 0.05 },
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
    expect(await t.kinds()).toEqual(['user_message', 'tool_call']);
  });

  it('counts the time used before this call of the loop', async () => {
    const t = await kit({
      script: [waitForAbort],
      limits: { runTimeoutSeconds: 10 },
    });
    // 9.95 s are used: 0.05 s are left for the model call.
    const { outcome } = await t.execute({
      stepsUsed: 0,
      toolCallsUsed: 0,
      elapsedSeconds: 9.95,
    });
    expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
  });

  it('still ends as cancelled when the user aborts before the deadline', async () => {
    const t = await kit({
      script: [waitForAbort],
      limits: { runTimeoutSeconds: 60 },
    });
    setTimeout(() => t.controller.abort(), 20);
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
  });
});

describe('AdvanceRun: the number of a step', () => {
  const afterTwoSteps = (): ItemBody[] => [
    { kind: 'user_message', text: 'q' },
    call('old-1', { step: 1 }),
    result('old-1'),
    call('old-2', { step: 2 }),
    result('old-2'),
  ];

  it('goes on after the newest step of the run in the log when the usage is behind', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [readTool],
      log: afterTwoSteps(),
    });
    // The usage says nothing was used: the backend crashed before it stored it.
    const { events } = await t.execute({
      stepsUsed: 0,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    });
    expect(
      events
        .filter(e => e.type === 'step.started')
        .map(e => (e as { step: number }).step),
    ).toEqual([3, 4]);
    const steps = (await t.read()).flatMap(i =>
      i.kind === 'tool_call' ? [i.step] : [],
    );
    expect(steps).toEqual([1, 2, 3]);
  });

  it('counts the steps of the log against the limit', async () => {
    const t = await kit({
      script: [[say('never')]],
      log: afterTwoSteps(),
      limits: { maxSteps: 2 },
    });
    const { outcome } = await t.execute({
      stepsUsed: 0,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    });
    expect(outcome).toEqual({ status: 'completed', endReason: 'max_steps' });
    expect(t.model.inputs).toHaveLength(0);
  });

  it('does not count the steps of another run', async () => {
    const t = await kit({
      script: [[say('ok')]],
      log: [{ kind: 'user_message', text: 'q' }],
      limits: { maxSteps: 2 },
    });
    const other = { runId: 'run-0', leaseOwner: 'backend-x' };
    t.items.grantLease(sessionId, other);
    await t.items.append(sessionId, afterTwoSteps().slice(1) as never, other);
    const { events } = await t.execute({
      stepsUsed: 0,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    });
    expect(events).toContainEqual({ type: 'step.started', step: 1 });
  });
});

describe('AdvanceRun: ids of the drafts', () => {
  it('gives two calls of one answer with the same model id different draft ids', async () => {
    const t = await kit({
      script: [
        [
          callTool('same', 'catalog:get-entity'),
          callTool('same', 'catalog:get-entity'),
        ],
        [say('ok')],
      ],
      tools: [readTool],
    });
    const { events } = await t.execute();
    const toolStarts = events.flatMap(e =>
      e.type === 'item.started' && e.kind === 'tool_call' ? [e] : [],
    );
    expect(toolStarts.map(e => e.modelCallId)).toEqual(['same', 'same']);
    expect(new Set(toolStarts.map(e => e.draftId)).size).toBe(2);
    const completed = events.flatMap(e =>
      e.type === 'item.completed' && e.item.kind === 'tool_call' ? [e] : [],
    );
    expect(completed.map(e => e.draftId)).toEqual(
      toolStarts.map(e => e.draftId),
    );
  });
});

describe('AdvanceRun: a call that cannot be checked', () => {
  it('writes an invalid result when the validation throws, and the run goes on', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('ok')]],
      tools: [
        {
          ...readTool,
          validate: () => {
            throw new Error('schema service down');
          },
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(0);
    expect((await t.read())[2]).toMatchObject({
      status: 'invalid',
      message: 'The input could not be checked.',
    });
  });

  it('writes nothing when the signal aborts while the input is checked', async () => {
    const t = await kit({
      script: [[callTool('m1', 'catalog:get-entity')], [say('never')]],
      tools: [
        {
          ...readTool,
          validate: () => {
            t.controller.abort();
            return { valid: true };
          },
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(await t.kinds()).toEqual(['user_message']);
  });
});

describe('AdvanceRun: a tool that sends data out', () => {
  it('does not run a read-only tool that sends data out when the user denies it', async () => {
    const egress: FakeTool = {
      descriptor: tool({ id: 'web:fetch', readOnly: true, egress: true }),
    };
    const t = await kit({
      script: [[callTool('m1', 'web:fetch')], [say('ok')]],
      tools: [egress],
    });
    const first = await t.execute();
    expect(first.outcome).toMatchObject({ status: 'waiting_approval' });
    await t.append(approval('call-1', 'deny'));
    const second = await t.execute();
    expect(second.outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(0);
    expect((await t.read()).find(i => i.kind === 'tool_result')).toMatchObject({
      callId: 'call-1',
      status: 'denied',
    });
  });
});

describe('AdvanceRun: the lease is lost while a tool runs', () => {
  it('throws LeaseLost, and the backend that takes over writes unknown and does not run the tool again', async () => {
    const t = await kit({
      script: [[say('I could not tell.')]],
      tools: [
        {
          ...writeTool,
          execute: () => {
            // Another backend took the run while the tool was running.
            t.items.grantLease(sessionId, {
              ...fence,
              leaseOwner: 'backend-b',
            });
            return { status: 'ok', output: {} };
          },
        },
      ],
      log: [
        { kind: 'user_message', text: 'deploy it' },
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
        }),
        approval('call-1'),
      ],
    });
    await expect(t.execute()).rejects.toBeInstanceOf(LeaseLost);
    expect(t.tools.executed).toHaveLength(1);
    expect((await t.kinds()).slice(-1)).toEqual(['tool_started']);

    const { outcome } = await t.execute(undefined, {
      ...fence,
      leaseOwner: 'backend-b',
    });
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed).toHaveLength(1);
    expect((await t.read()).find(i => i.kind === 'tool_result')).toMatchObject({
      callId: 'call-1',
      status: 'unknown',
    });
  });
});

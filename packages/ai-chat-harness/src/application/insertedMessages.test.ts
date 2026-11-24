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
  decideNextAction,
  insertStatesOf,
  SUMMARY_PROMPT,
  type Item,
  type ItemBody,
  type ModelInput,
} from '../domain';
import {
  agentSays,
  approve,
  call,
  limits,
  result,
  tool,
  usage,
  user,
} from '../domain/fixtures';
import { callTool, say } from '../testing';
import type { FakeTool } from '../testing';
import { kit, fence, sessionId } from '../testing/fixture';

type Kit = Awaited<ReturnType<typeof kit>>;

const readTool: FakeTool = {
  descriptor: tool({ id: 'catalog:get-entity', readOnly: true }),
  execute: () => ({ status: 'ok', output: { name: 'service-a' } }),
};

// The log of the fake runs the body of an append at once, so a model, a tool
// or a heartbeat of a test can write the message the way the host does while
// the loop is busy.
function insert(t: Kit, text: string): void {
  void t.items.append(
    sessionId,
    [{ kind: 'user_message', text, delivery: 'inserted' }],
    fence,
  );
}

const roles = (input: ModelInput) => input.messages.map(m => m.role);
const texts = (input: ModelInput) => input.messages.map(m => m.content);
const types = (events: { type: string }[]) => events.map(e => e.type);

describe('AdvanceRun: a message inserted while the model answers (IN-10, IN-11)', () => {
  it('writes the output as it was, marks what it read, and reads the message at the next call', async () => {
    const holder: { t?: Kit } = {};
    const t = await kit({
      script: [
        () => {
          insert(holder.t!, 'also check the owner');
          return [say('first answer')];
        },
        [say('second answer')],
      ],
    });
    holder.t = t;
    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    const log = await t.read();
    expect(log.map(i => i.kind)).toEqual([
      'user_message',
      'user_message',
      'agent_message',
      'agent_message',
    ]);
    // The first answer is written as the model gave it; it did not read the
    // message (seq 2).
    expect(log[2]).toMatchObject({ text: 'first answer', readUpToSeq: 1 });
    expect(log[3]).toMatchObject({ text: 'second answer', readUpToSeq: 3 });
    expect(insertStatesOf(log).get(2)).toBe('read');
    // The first input does not have the message, the second one does. The
    // log is read in the order of `seq`: the message came before the answer
    // that did not read it.
    expect(texts(t.model.inputs[0])).toEqual(['question']);
    expect(texts(t.model.inputs[1])).toEqual([
      'question',
      'also check the owner',
      'first answer',
    ]);
  });

  it('decides call_model, not complete, on the log with the first answer only', async () => {
    const holder: { t?: Kit } = {};
    const t = await kit({
      script: [
        () => {
          insert(holder.t!, 'also check the owner');
          return [say('first answer')];
        },
        [say('second answer')],
      ],
    });
    holder.t = t;
    await t.execute();
    const afterFirst = (await t.read()).slice(0, 3);
    expect(
      decideNextAction(afterFirst, usage({ stepsUsed: 1 }), limits),
    ).toEqual({ type: 'call_model' });
    expect(insertStatesOf(afterFirst).get(2)).toBe('unread');
  });

  it('counts the call that reads the message as a step, and the message as no step', async () => {
    const holder: { t?: Kit } = {};
    const t = await kit({
      script: [
        () => {
          insert(holder.t!, 'more');
          return [say('first')];
        },
        [say('second')],
      ],
    });
    holder.t = t;
    await t.execute();
    // The usage written after the first round counts one step; the message
    // did not add one.
    expect(t.run.usage[0].stepsUsed).toBe(1);
    expect(t.lastUsage().stepsUsed).toBe(2);
    expect(t.model.inputs).toHaveLength(2);
  });

  it('stops with max_steps when the steps are used up, and does not call the model again', async () => {
    const holder: { t?: Kit } = {};
    const t = await kit({
      script: [
        () => {
          insert(holder.t!, 'too late');
          return [say('only answer')];
        },
      ],
      limits: { maxSteps: 1 },
    });
    holder.t = t;
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed', endReason: 'max_steps' });
    expect(t.model.inputs).toHaveLength(1);
    expect(insertStatesOf(await t.read()).get(2)).toBe('unread');
    expect(t.lastUsage().stepsUsed).toBe(1);
  });
});

describe('AdvanceRun: a message inserted after the last answer (IN-11)', () => {
  it('does not end the run: the model is called once more, and the run completes after it read the message', async () => {
    const t = await kit({
      script: [[say('first answer')], [say('with the message')]],
    });
    const heartbeat = t.run.heartbeat.bind(t.run);
    let count = 0;
    jest.spyOn(t.run, 'heartbeat').mockImplementation(async f => {
      count += 1;
      // The second heartbeat is the start of the round after the first answer,
      // before the log is read.
      if (count === 2) insert(t, 'one more thing');
      return heartbeat(f);
    });
    const { events, outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(t.model.inputs).toHaveLength(2);
    expect(texts(t.model.inputs[1])).toEqual([
      'question',
      'first answer',
      'one more thing',
    ]);
    expect(types(events).filter(e => e === 'run.ended')).toHaveLength(1);
    const log = await t.read();
    expect(log[log.length - 1]).toMatchObject({
      text: 'with the message',
      readUpToSeq: 3,
    });
  });
});

describe('AdvanceRun: a message inserted while tools run', () => {
  it('goes after all the results of the step, between two calls too', async () => {
    const holder: { t?: Kit } = {};
    const inserting: FakeTool = {
      descriptor: tool({ id: 'catalog:get-entity', readOnly: true }),
      execute: item => {
        if (item.callId === 'call-2') insert(holder.t!, 'change of plan');
        return { status: 'ok', output: { id: item.callId } };
      },
    };
    const t = await kit({
      script: [
        [
          callTool('m1', 'catalog:get-entity'),
          callTool('m2', 'catalog:get-entity'),
        ],
        [say('done')],
      ],
      tools: [inserting],
    });
    holder.t = t;
    await t.execute();

    const second = t.model.inputs[1];
    expect(roles(second)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(second.messages[4]).toEqual({
      role: 'user',
      content: 'change of plan',
    });
  });

  it('puts the message after the result when it comes between the two results', async () => {
    const holder: { t?: Kit } = {};
    const inserting: FakeTool = {
      descriptor: tool({ id: 'catalog:get-entity', readOnly: true }),
      execute: item => {
        if (item.callId === 'call-1') insert(holder.t!, 'change of plan');
        return { status: 'ok', output: { id: item.callId } };
      },
    };
    const t = await kit({
      script: [
        [
          callTool('m1', 'catalog:get-entity'),
          callTool('m2', 'catalog:get-entity'),
        ],
        [say('done')],
      ],
      tools: [inserting],
    });
    holder.t = t;
    await t.execute();
    const second = t.model.inputs[1];
    expect(roles(second)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(
      second.messages.filter(m => m.role === 'tool').map(m => m.callId),
    ).toEqual(['call-1', 'call-2']);
  });

  it('runs a call that was approved before the message came', async () => {
    const t = await kit({
      script: [[say('done')]],
      tools: [
        {
          descriptor: tool({
            id: 'temporal:start-workflow',
            readOnly: false,
          }),
          execute: () => ({ status: 'ok', output: { started: true } }),
        },
      ],
      log: [
        user('deploy') as ItemBody,
        call('call-1', {
          policy: 'ask',
          readOnly: false,
          toolId: 'temporal:start-workflow',
          readUpToSeq: 1,
        }),
        approve('call-1') as ItemBody,
        {
          kind: 'user_message',
          text: 'and tell me when',
          delivery: 'inserted',
        },
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.tools.executed.map(c => c.callId)).toEqual(['call-1']);
    expect(roles(t.model.inputs[0])).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(texts(t.model.inputs[0])[3]).toBe('and tell me when');
  });
});

describe('AdvanceRun: message.read', () => {
  it('is sent before the step.started of the call that reads the message, once', async () => {
    const holder: { t?: Kit } = {};
    const t = await kit({
      script: [
        () => {
          insert(holder.t!, 'a note from the user');
          return [callTool('m1', 'catalog:get-entity')];
        },
        [callTool('m2', 'catalog:get-entity')],
        [say('done')],
      ],
      tools: [readTool],
    });
    holder.t = t;
    const { events } = await t.execute();

    const sequence = types(events);
    expect(sequence.filter(e => e === 'message.read')).toHaveLength(1);
    const read = sequence.indexOf('message.read');
    const steps = sequence.reduce<number[]>(
      (at, e, i) => (e === 'step.started' ? [...at, i] : at),
      [],
    );
    expect(steps).toHaveLength(3);
    expect(read).toBeGreaterThan(steps[0]);
    expect(read).toBeLessThan(steps[1]);
    expect(sequence[read + 1]).toBe('step.started');
    expect(events[read]).toMatchObject({
      type: 'message.read',
      item: { kind: 'user_message', text: 'a note from the user', seq: 2 },
    });
  });

  it('is not sent for the first message, or when nothing was inserted', async () => {
    const t = await kit({ script: [[say('hi')]] });
    const { events } = await t.execute();
    expect(types(events)).not.toContain('message.read');
  });

  it('is sent for each of two messages that one call reads, in the order of seq', async () => {
    const holder: { t?: Kit } = {};
    const t = await kit({
      script: [
        () => {
          insert(holder.t!, 'one');
          insert(holder.t!, 'two');
          return [say('first')];
        },
        [say('second')],
      ],
    });
    holder.t = t;
    const { events } = await t.execute();
    const reads = events.filter(e => e.type === 'message.read');
    expect(reads.map(e => (e as { item: Item }).item.seq)).toEqual([2, 3]);
  });

  it('is sent again by a later call of the loop only for a message that was not read', async () => {
    // A message read by an earlier call has a mark above it.
    const t = await kit({
      script: [[say('second')]],
      log: [
        user('Q') as ItemBody,
        { kind: 'user_message', text: 'read', delivery: 'inserted' },
        agentSays('first', 2),
        { kind: 'user_message', text: 'new', delivery: 'inserted' },
      ],
    });
    const { events } = await t.execute();
    expect(
      events
        .filter(e => e.type === 'message.read')
        .map(e => (e as { item: Item & { text: string } }).item.text),
    ).toEqual(['new']);
  });
});

describe('AdvanceRun: a message inserted while a summary is made', () => {
  it('marks the output with what the loop read, so the message is read at the next round', async () => {
    const holder: { t?: Kit } = {};
    const body = (input: ModelInput) =>
      input.system === SUMMARY_PROMPT ? [say('The summary.')] : [say('answer')];
    let inserted = false;
    const t = await kit({
      script: [
        input => {
          if (!inserted) {
            inserted = true;
            insert(holder.t!, 'during the summary');
          }
          return body(input);
        },
        body,
        body,
        body,
      ],
      tools: [readTool],
      budget: { tokenBudget: 700, keepRecentSteps: 2 },
      log: [
        user('first question') as ItemBody,
        ...Array.from({ length: 8 }, (_v, i): ItemBody[] => [
          agentSays(`looking at ${i + 1}`),
          call(`c${i + 1}`, { step: i + 1 }),
          result(`c${i + 1}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
        ]).flat(),
        user('the question'),
      ],
    });
    holder.t = t;
    await t.execute();

    const log = await t.read();
    const message = log.find(
      i => i.kind === 'user_message' && i.text === 'during the summary',
    )!;
    const summary = log.find(i => i.kind === 'summary')!;
    const firstAnswer = log.find(
      i => i.kind === 'agent_message' && i.text === 'answer',
    ) as Item & { readUpToSeq: number };
    // The summary was written after the message, so it has a larger seq.
    expect(summary.seq).toBeGreaterThan(message.seq);
    // The answer counts as having read what the loop read, not the summary.
    expect(firstAnswer.readUpToSeq).toBeLessThan(message.seq);
    expect(firstAnswer.readUpToSeq).toBe(message.seq - 1);
    // So the message was not read then, and the loop read it the next round.
    expect(
      insertStatesOf(log.filter(i => i.seq <= firstAnswer.seq)).get(
        message.seq,
      ),
    ).toBe('unread');
    const answers = t.model.inputs.filter(i => i.system !== SUMMARY_PROMPT);
    expect(texts(answers[0])).not.toContain('during the summary');
    expect(texts(answers[answers.length - 1])).toContain('during the summary');
    expect(insertStatesOf(log).get(message.seq)).toBe('read');
  });
});

describe('AdvanceRun: a log of P1', () => {
  it('has no mark and no delivery, and behaves as before', async () => {
    const t = await kit({
      script: [[say('next')]],
      tools: [readTool],
      log: [
        user('Q') as ItemBody,
        agentSays('looking'),
        call('c1'),
        result('c1'),
      ],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.model.inputs).toHaveLength(1);
    expect(t.run.usage.length).toBeGreaterThan(0);
  });

  it('completes a run whose last answer has no mark, without calling the model', async () => {
    const t = await kit({
      script: [],
      log: [user('Q') as ItemBody, agentSays('done')],
    });
    const { outcome } = await t.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(t.model.inputs).toHaveLength(0);
  });
});

describe('AdvanceRun: the mark of the output', () => {
  it('is on the agent_message and on every tool_call of one round, the same value', async () => {
    const t = await kit({
      script: [
        [
          say('text'),
          callTool('m1', 'catalog:get-entity'),
          callTool('m2', 'catalog:get-entity'),
        ],
        [say('done')],
      ],
      tools: [readTool],
    });
    await t.execute();
    const log = await t.read();
    const marked = log.filter(
      i => i.kind === 'agent_message' || i.kind === 'tool_call',
    ) as (Item & { readUpToSeq?: number })[];
    expect(marked.map(i => i.readUpToSeq)).toEqual([1, 1, 1, 6]);
  });

  it('is also on a call that is refused at once', async () => {
    const t = await kit({
      script: [[callTool('m1', 'unknown:tool')], [say('done')]],
    });
    await t.execute();
    const refused = (await t.read()).find(
      i => i.kind === 'tool_call',
    ) as Item & { readUpToSeq?: number };
    expect(refused.readUpToSeq).toBe(1);
  });
});

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

import type { ItemBody, ToolResultItem } from '../domain';
import { agentSays, call, result, tool, user } from '../domain/fixtures';
import { callTool, say, usedTokens, waitForAbort } from '../testing';
import type { FakeTool } from '../testing';
import { kit, RecordingObserver } from '../testing/fixture';
import type { ContextProvider, Extensions } from './ports/extensions';
import type { RunObserver, ToolCallRecord } from './ports/RunObserver';
import { CONTEXT_PROVIDER_TIMEOUT_MS } from './steps/contextProviders';

function fakeTool(
  id: string,
  readOnly: boolean,
  execute?: FakeTool['execute'],
): FakeTool {
  return {
    descriptor: tool({ id, readOnly, schemaHash: `hash-${id}` }),
    ...(execute && { execute }),
  };
}

const never = <T>() => new Promise<T>(() => undefined);
const byTool = (records: ToolCallRecord[]) =>
  Object.fromEntries(records.map(record => [record.toolId, record]));

describe('RunObserver: model calls (O-01)', () => {
  it('records each step with the ids, the reported tokens and the outcome', async () => {
    const t = await kit({
      modelId: 'fast',
      tools: [fakeTool('catalog:read', true)],
      script: [
        [callTool('m1', 'catalog:read'), usedTokens(120, 30)],
        [say('done'), usedTokens(200, 8)],
      ],
    });

    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(t.observed.modelCalls).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'default',
        modelId: 'fast',
        purpose: 'step',
        step: 1,
        outcome: 'ok',
        inputTokens: 120,
        outputTokens: 30,
        toolCallsRequested: 1,
      }),
      expect.objectContaining({
        step: 2,
        outcome: 'ok',
        inputTokens: 200,
        outputTokens: 8,
        toolCallsRequested: 0,
      }),
    ]);
  });

  it('keeps the last usage, ignores counts that are not counts, and leaves the tokens out when none is reported', async () => {
    const t = await kit({
      script: [
        [
          usedTokens(1, 1),
          say('a'),
          usedTokens(5, 6),
          usedTokens(-1, 2),
          usedTokens(1.5, 2),
        ],
      ],
    });
    await t.execute();
    expect(t.observed.modelCalls[0]).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
    });

    const none = await kit({ script: [[say('a')]] });
    await none.execute();
    expect(none.observed.modelCalls[0]).not.toHaveProperty('inputTokens');
    expect(none.observed.modelCalls[0]).not.toHaveProperty('outputTokens');
  });

  it('stores and reports nothing for usage: the log and the events are the same without it', async () => {
    const script = (withUsage: boolean) => [
      [
        ...(withUsage ? [usedTokens(10, 2)] : []),
        say('Hello'),
        ...(withUsage ? [usedTokens(10, 3)] : []),
      ],
    ];
    const plain = await kit({ script: script(false) });
    const counted = await kit({ script: script(true) });

    const a = await plain.execute();
    const b = await counted.execute();

    expect(b.events).toEqual(a.events);
    expect(b.outcome).toEqual(a.outcome);
    expect(await counted.read()).toEqual(await plain.read());
  });

  it('measures the duration of the model call with the clock', async () => {
    let advance = (_seconds: number) => {};
    const t = await kit({
      script: [
        () => {
          advance(1.5);
          return [say('slow answer')];
        },
      ],
    });
    advance = seconds => t.clock.advance(seconds);

    await t.execute();

    expect(t.observed.modelCalls[0].durationMs).toBe(1500);
  });

  it('records a failed call with the HTTP status of the error and nothing of its message', async () => {
    const error = Object.assign(new Error('secret body of the server'), {
      status: 503,
    });
    const t = await kit({ script: [error] });

    const { outcome } = await t.execute();

    expect(outcome.status).toBe('failed');
    expect(t.observed.modelCalls[0]).toMatchObject({
      outcome: 'failed',
      errorStatus: 503,
    });
    expect(JSON.stringify(t.observed.modelCalls)).not.toContain('secret');
  });

  it('gives no errorStatus for a status that is not an HTTP one', async () => {
    const t = await kit({
      script: [Object.assign(new Error('x'), { status: 'bad' })],
    });
    await t.execute();
    expect(t.observed.modelCalls[0]).not.toHaveProperty('errorStatus');
  });

  it('records an answer with neither text nor calls as empty', async () => {
    const t = await kit({ script: [[]] });
    await t.execute();
    expect(t.observed.modelCalls[0].outcome).toBe('empty');
  });

  it('records no model call when beforeModelCall throws', async () => {
    const t = await kit({
      script: [[say('never')]],
      extensions: {
        hooks: {
          beforeModelCall: [
            () => {
              throw new Error('hook');
            },
          ],
        },
      },
    });
    const { outcome } = await t.execute();
    expect(outcome.status).toBe('failed');
    expect(t.observed.modelCalls).toEqual([]);
  });

  it('tells the deadline of the run (timeout) from a stop of the user (cancelled)', async () => {
    const late = await kit({
      limits: { runTimeoutSeconds: 0.05 },
      script: [waitForAbort],
    });
    const lateRun = await late.execute();
    expect(lateRun.outcome).toEqual({
      status: 'completed',
      endReason: 'timeout',
    });
    expect(late.observed.modelCalls[0].outcome).toBe('timeout');

    const stopped = await kit({ script: [waitForAbort] });
    setTimeout(() => stopped.controller.abort(), 20);
    const stoppedRun = await stopped.execute();
    expect(stoppedRun.outcome).toEqual({ status: 'cancelled' });
    expect(stopped.observed.modelCalls[0].outcome).toBe('cancelled');
  });

  it('records the summary made before a step as its own call', async () => {
    const big: ItemBody[] = [user('first question')];
    for (let i = 1; i <= 8; i++) {
      big.push(
        agentSays(`looking at ${i}`),
        call(`c${i}`, { step: i }),
        result(`c${i}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
      );
    }
    big.push(user('next question'));
    const t = await kit({
      policy: { byTool: { update_plan: 'deny' } },
      tools: [fakeTool('catalog:get-entity', true)],
      budget: { tokenBudget: 700, keepRecentSteps: 2 },
      log: big,
      script: [
        [say('The summary.'), usedTokens(500, 40)],
        [say('The answer.')],
      ],
    });

    await t.execute();

    // The old steps of the log are of the same run, so this is step 9.
    expect(t.observed.modelCalls.map(r => [r.purpose, r.step])).toEqual([
      ['summary', 9],
      ['step', 9],
    ]);
    expect(t.observed.modelCalls[0]).toMatchObject({
      outcome: 'ok',
      inputTokens: 500,
      toolCallsRequested: 0,
    });
    expect(t.observed.modelCalls[0]).not.toHaveProperty('providers');
    expect(t.observed.modelCalls[1].context.summarized).toBe(true);
  });

  it('records a summary that fails or gives no text, and the run goes on', async () => {
    const big: ItemBody[] = [user('first question')];
    for (let i = 1; i <= 8; i++) {
      big.push(
        agentSays(`looking at ${i}`),
        call(`c${i}`, { step: i }),
        result(`c${i}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
      );
    }
    big.push(user('next question'));
    const options = {
      policy: { byTool: { update_plan: 'deny' as const } },
      tools: [fakeTool('catalog:get-entity', true)],
      budget: { tokenBudget: 700, keepRecentSteps: 2 },
      log: big,
    };
    const failed = await kit({
      ...options,
      script: [new Error('down'), [say('The answer.')]],
    });
    const empty = await kit({
      ...options,
      script: [[say('  ')], [say('The answer.')]],
    });

    expect((await failed.execute()).outcome).toEqual({ status: 'completed' });
    expect((await empty.execute()).outcome).toEqual({ status: 'completed' });
    expect(failed.observed.modelCalls[0]).toMatchObject({
      purpose: 'summary',
      outcome: 'failed',
    });
    expect(empty.observed.modelCalls[0]).toMatchObject({
      purpose: 'summary',
      outcome: 'empty',
    });
  });
});

describe('RunObserver: the size of the context (O-01)', () => {
  it('sums the parts into estimatedTokens and gives the budget and the counts', async () => {
    const t = await kit({
      tools: [fakeTool('catalog:read', true)],
      budget: { tokenBudget: 24000, keepRecentSteps: 6 },
      script: [[say('done')]],
    });

    await t.execute();

    const { context } = t.observed.modelCalls[0];
    const { parts } = context;
    expect(context.estimatedTokens).toBe(
      parts.system +
        parts.context +
        parts.tools +
        parts.summary +
        parts.history +
        parts.images,
    );
    expect(context.budgetTokens).toBe(24000);
    expect(parts.system).toBeGreaterThan(0);
    expect(parts.tools).toBeGreaterThan(0);
    expect(parts.history).toBeGreaterThan(0);
    expect(parts.summary).toBe(0);
    expect(parts.images).toBe(0);
    expect(context).toMatchObject({
      messages: 1,
      images: 0,
      // catalog:read and the built-in update_plan.
      tools: 2,
      summarized: false,
      trimmed: [],
    });
  });

  it('counts the context of the step apart from the system prompt of the agent', async () => {
    const provider: ContextProvider = {
      id: 'team',
      provide: () => 'The team is platform.',
    };
    const plain = await kit({
      script: [[say('a')]],
      extensions: { contextProviders: [] },
    });
    const withContext = await kit({
      script: [[say('a')]],
      extensions: { contextProviders: [provider] },
    });
    await plain.execute();
    await withContext.execute();

    const a = plain.observed.modelCalls[0].context.parts;
    const b = withContext.observed.modelCalls[0].context.parts;
    expect(a.context).toBe(0);
    expect(b.context).toBeGreaterThan(0);
    expect(b.system).toBe(a.system);
  });

  it('counts the images sent, at tokensPerImage each', async () => {
    const t = await kit({
      capabilities: { images: true },
      budget: { tokenBudget: 24000, keepRecentSteps: 6, tokensPerImage: 100 },
      log: [
        {
          kind: 'user_message',
          text: 'look',
          attachments: [
            {
              attachmentId: 'a1',
              mediaType: 'image/png',
              name: 'one.png',
              size: 10,
            },
            {
              attachmentId: 'a2',
              mediaType: 'image/png',
              name: 'two.png',
              size: 10,
            },
          ],
        } as ItemBody,
      ],
      script: [[say('seen')]],
    });

    await t.execute();

    expect(t.observed.modelCalls[0].context).toMatchObject({
      images: 2,
      parts: expect.objectContaining({ images: 200 }),
    });
  });

  it('says which parts the budget left out', async () => {
    const log: ItemBody[] = [user('first question')];
    for (let i = 1; i <= 8; i++) {
      log.push(
        agentSays(`looking at ${i}`),
        call(`c${i}`, { step: i }),
        result(`c${i}`, 'ok', { output: { text: `${i}`.repeat(800) } }),
      );
    }
    log.push(user('next question'));
    const t = await kit({
      policy: { byTool: { update_plan: 'deny' } },
      tools: [fakeTool('catalog:get-entity', true)],
      budget: { tokenBudget: 700, keepRecentSteps: 2 },
      log,
      // The summary fails, so the old steps are left out instead.
      script: [new Error('down'), [say('The answer.')]],
    });

    await t.execute();

    const step = t.observed.modelCalls.find(r => r.purpose === 'step');
    expect(step?.context.trimmed).toEqual(['earlier']);
    expect(step?.context.summarized).toBe(false);
  });

  it('reports each context provider with its status and the length it has in the context', async () => {
    jest.useFakeTimers();
    try {
      const long = 'x'.repeat(9000);
      const providers: ContextProvider[] = [
        { id: 'fine', provide: () => 'short text' },
        { id: 'long', provide: () => long },
        { id: 'quiet', provide: () => undefined },
        {
          id: 'broken',
          provide: () => {
            throw new Error('down');
          },
        },
        { id: 'slow', provide: () => never<string>() },
        { id: 'big', provide: () => long },
        { id: 'late', provide: () => 'no room left' },
      ];
      const t = await kit({
        script: [[say('a')]],
        extensions: { contextProviders: providers },
      });

      const running = t.execute();
      await jest.advanceTimersByTimeAsync(CONTEXT_PROVIDER_TIMEOUT_MS);
      await running;

      const records = t.observed.modelCalls[0].providers ?? [];
      expect(records.map(r => [r.id, r.status])).toEqual([
        ['fine', 'ok'],
        ['long', 'cut'],
        ['quiet', 'empty'],
        ['broken', 'failed'],
        ['slow', 'timeout'],
        ['big', 'cut'],
        ['late', 'left_out'],
      ]);
      const chars = Object.fromEntries(records.map(r => [r.id, r.chars]));
      expect(chars.fine).toBe('short text'.length);
      expect(chars.long).toBe(8000);
      expect(chars.big).toBe(16000 - 10 - 8000);
      expect(chars.quiet).toBe(0);
      expect(chars.late).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('RunObserver: tool calls (O-01)', () => {
  it('records every result of a step with its status and why it was denied', async () => {
    const hooks: Extensions['hooks'] = {
      beforeToolCall: [
        toolCall =>
          toolCall.toolId === 'x:hooked'
            ? { action: 'deny', reason: 'secret reason' }
            : { action: 'continue' },
      ],
    };
    const t = await kit({
      tools: [
        fakeTool('x:ok', true, () => ({
          status: 'ok',
          output: { secret: 'output' },
        })),
        fakeTool('x:error', true, () => {
          throw new Error('secret failure');
        }),
        fakeTool('x:slow', true, () => never()),
        fakeTool('x:denied', true),
        fakeTool('x:hooked', true),
        fakeTool('x:over', true),
      ],
      policy: { byTool: { 'x:denied': 'deny' } },
      limits: { maxToolCallsPerStep: 6, toolTimeoutSeconds: 0.05 },
      extensions: { hooks },
      script: [
        [
          callTool('m1', 'x:ok'),
          callTool('m2', 'x:error'),
          callTool('m3', 'x:slow'),
          callTool('m4', 'x:unknown'),
          callTool('m5', 'x:denied'),
          callTool('m6', 'x:hooked'),
          callTool('m7', 'x:over'),
        ],
        [say('done')],
      ],
    });

    await t.execute();

    const records = byTool(t.observed.toolCalls);
    expect(Object.keys(records)).toHaveLength(7);
    expect(records['x:ok']).toMatchObject({ status: 'ok', position: 0 });
    expect(records['x:error']).toMatchObject({ status: 'error' });
    expect(records['x:slow']).toMatchObject({ status: 'timeout' });
    expect(records['x:unknown']).toMatchObject({ status: 'invalid' });
    expect(records['x:denied']).toMatchObject({
      status: 'denied',
      reason: 'policy',
    });
    expect(records['x:hooked']).toMatchObject({
      status: 'denied',
      reason: 'hook',
    });
    expect(records['x:over']).toMatchObject({
      status: 'denied',
      reason: 'step_limit',
    });
    for (const id of ['x:ok', 'x:error', 'x:slow']) {
      expect(records[id].durationMs).toEqual(expect.any(Number));
    }
    for (const id of ['x:unknown', 'x:denied', 'x:hooked', 'x:over']) {
      expect(records[id]).not.toHaveProperty('durationMs');
    }
    expect(records['x:invalid']).toBeUndefined();
    for (const record of t.observed.toolCalls) {
      expect(record).toMatchObject({
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'default',
        step: 1,
        readOnly: record.toolId !== 'x:unknown',
      });
    }
    expect(JSON.stringify(t.observed.toolCalls)).not.toContain('secret');
  });

  it('records the calls over the limit of the run as run_limit', async () => {
    const t = await kit({
      tools: [fakeTool('x:read', true)],
      limits: { maxToolCallsPerRun: 1 },
      script: [
        [callTool('m1', 'x:read'), callTool('m2', 'x:read')],
        [say('done')],
      ],
    });
    await t.execute();
    expect(
      t.observed.toolCalls.map(r => [r.position, r.status, r.reason]),
    ).toEqual(
      expect.arrayContaining([
        [0, 'ok', undefined],
        [1, 'denied', 'run_limit'],
      ]),
    );
  });

  it('measures only the tool: not the hooks and not the wait for an approval', async () => {
    let advance = (_seconds: number) => {};
    const t = await kit({
      tools: [
        fakeTool('x:write', false, () => {
          advance(0.8);
          return { status: 'ok' };
        }),
      ],
      extensions: {
        hooks: {
          beforeToolCall: [
            () => {
              advance(0.5);
              return { action: 'continue' };
            },
          ],
          afterToolCall: [
            (_call, output) => {
              advance(0.3);
              return output;
            },
          ],
        },
      },
      script: [[callTool('m1', 'x:write')], [say('done')]],
    });
    advance = seconds => t.clock.advance(seconds);

    const first = await t.execute();
    expect(first.outcome.status).toBe('waiting_approval');
    expect(t.observed.toolCalls).toEqual([]);
    t.clock.advance(100);
    const [pending] = (first.outcome as { pending: { callId: string }[] })
      .pending;
    await t.append({
      kind: 'approval',
      callId: pending.callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });
    await t.execute();

    expect(t.observed.toolCalls).toEqual([
      expect.objectContaining({
        toolId: 'x:write',
        readOnly: false,
        status: 'ok',
        durationMs: 800,
      }),
    ]);
  });

  it('records the status the afterToolCall hook leaves, with the time of the tool', async () => {
    let advance = (_seconds: number) => {};
    const t = await kit({
      tools: [
        fakeTool('x:read', true, () => {
          advance(0.25);
          return { status: 'ok', output: { a: 1 } };
        }),
      ],
      extensions: {
        hooks: {
          afterToolCall: [() => ({ status: 'error', message: 'changed' })],
        },
      },
      script: [[callTool('m1', 'x:read')], [say('done')]],
    });
    advance = seconds => t.clock.advance(seconds);

    await t.execute();

    expect(t.observed.toolCalls[0]).toMatchObject({
      status: 'error',
      durationMs: 250,
    });
  });

  it('records a call the user denied as denied by the user', async () => {
    const t = await kit({
      tools: [fakeTool('x:write', false)],
      script: [[callTool('m1', 'x:write')], [say('ok')]],
    });
    const first = await t.execute();
    const [pending] = (first.outcome as { pending: { callId: string }[] })
      .pending;
    await t.append({
      kind: 'approval',
      callId: pending.callId,
      decision: 'deny',
      decidedBy: 'user:a',
    });
    await t.execute();

    expect(t.observed.toolCalls).toEqual([
      expect.objectContaining({ status: 'denied', reason: 'user' }),
    ]);
    expect(t.observed.toolCalls[0]).not.toHaveProperty('durationMs');
  });

  it('records a later change of a step whose earlier change timed out', async () => {
    const t = await kit({
      tools: [
        fakeTool('x:first', false, () => never()),
        fakeTool('x:second', false),
      ],
      policy: { byTool: { 'x:first': 'allow', 'x:second': 'allow' } },
      limits: { toolTimeoutSeconds: 0.05 },
      script: [
        [callTool('m1', 'x:first'), callTool('m2', 'x:second')],
        [say('done')],
      ],
    });
    const first = await t.execute();
    for (const pending of (first.outcome as { pending?: { callId: string }[] })
      .pending ?? []) {
      await t.append({
        kind: 'approval',
        callId: pending.callId,
        decision: 'allow',
        decidedBy: 'user:a',
      });
    }
    if (first.outcome.status === 'waiting_approval') await t.execute();

    const records = byTool(t.observed.toolCalls);
    expect(records['x:first']).toMatchObject({ status: 'timeout' });
    expect(records['x:second']).toMatchObject({
      status: 'denied',
      reason: 'earlier_write_timed_out',
    });
  });

  it('records an interrupted call as unknown, without a duration', async () => {
    const t = await kit({
      tools: [fakeTool('x:write', false)],
      log: [
        user('change it'),
        call('c1', { toolId: 'x:write', policy: 'ask', readOnly: false }),
        { kind: 'approval', callId: 'c1', decision: 'allow', decidedBy: 'u' },
        { kind: 'tool_started', callId: 'c1' },
      ],
      script: [[say('It may have run.')]],
    });

    await t.execute();

    expect(t.observed.toolCalls).toEqual([
      expect.objectContaining({
        callId: 'c1',
        toolId: 'x:write',
        status: 'unknown',
        readOnly: false,
      }),
    ]);
    expect(t.observed.toolCalls[0]).not.toHaveProperty('durationMs');
  });

  it('records read-only calls that run at the same time in the order their results are written', async () => {
    const t = await kit({
      tools: [
        fakeTool(
          'x:read',
          true,
          async c =>
            new Promise(resolve =>
              setTimeout(
                () => resolve({ status: 'ok' }),
                (5 - Number(c.input.n)) * 10,
              ),
            ),
        ),
      ],
      script: [
        [1, 2, 3, 4].map(n => callTool(`m${n}`, 'x:read', { n: String(n) })),
        [say('done')],
      ],
    });

    await t.execute();

    const written = (await t.read())
      .filter((item): item is ToolResultItem => item.kind === 'tool_result')
      .map(item => item.callId);
    expect(t.observed.toolCalls.map(r => r.callId)).toEqual(written);
    expect(t.observed.toolCalls.map(r => r.position)).toEqual([0, 1, 2, 3]);
  });

  it('records the truncated flag of the result', async () => {
    const t = await kit({
      tools: [
        fakeTool('x:read', true, () => ({
          status: 'ok',
          output: 'part',
          truncated: true,
        })),
      ],
      script: [[callTool('m1', 'x:read')], [say('done')]],
    });
    await t.execute();
    expect(t.observed.toolCalls[0].truncated).toBe(true);
  });
});

describe('RunObserver: the run stays the same', () => {
  const scenario = (observer?: RunObserver) =>
    kit({
      ...(observer === undefined ? { observer: undefined } : { observer }),
      tools: [fakeTool('x:read', true)],
      script: [
        [say('Looking.'), callTool('m1', 'x:read'), usedTokens(3, 4)],
        [say('done')],
      ],
    });

  it('runs the same with no observer, with one, and with one that throws', async () => {
    const throwing: RunObserver = {
      modelCall: () => {
        throw new Error('observer down');
      },
      toolCall: () => {
        throw new Error('observer down');
      },
    };
    const none = await scenario();
    const recording = new RecordingObserver();
    const recorded = await scenario(recording);
    const broken = await scenario(throwing);

    const a = await none.execute();
    const b = await recorded.execute();
    const c = await broken.execute();

    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(await recorded.read()).toEqual(await none.read());
    expect(await broken.read()).toEqual(await none.read());
    expect(recording.modelCalls).toHaveLength(2);
    expect(recording.toolCalls).toHaveLength(1);
  });
});

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

import { LeaseLost } from '../domain';
import type { Item, ToolCallItem, ToolResultItem } from '../domain';
import type { HarnessEvent } from './events';
import type { Extensions } from './ports/extensions';
import type { ToolOutput } from './ports/ToolGateway';
import { kit } from '../testing/fixture';
import type { FakeTool } from '../testing/FakeToolGateway';
import { callTool, say } from '../testing/ScriptedModel';

function tool(
  id: string,
  readOnly: boolean,
  execute: FakeTool['execute'],
  extra: { egress?: boolean } = {},
): FakeTool {
  return {
    descriptor: {
      id,
      description: `The tool ${id}`,
      inputSchema: { type: 'object' },
      schemaHash: `hash-${id}`,
      readOnly,
      ...extra,
    },
    execute,
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A promise and the function that resolves it. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

/** Records when each call starts and ends, and how many run at once. */
function tracker() {
  const trace: string[] = [];
  let running = 0;
  let most = 0;
  return {
    trace,
    most: () => most,
    async around(name: string, body: () => Promise<ToolOutput>) {
      trace.push(`start:${name}`);
      running += 1;
      most = Math.max(most, running);
      try {
        return await body();
      } finally {
        running -= 1;
        trace.push(`end:${name}`);
      }
    },
  };
}

const resultsOf = (items: Item[]) =>
  items.filter((item): item is ToolResultItem => item.kind === 'tool_result');
const callsOf = (items: Item[]) =>
  items.filter((item): item is ToolCallItem => item.kind === 'tool_call');
const completedKinds = (events: HarnessEvent[]) =>
  events.flatMap(event =>
    event.type === 'item.completed' ? [event.item.kind] : [],
  );

describe('executeTools: read-only calls at the same time (P-01, P-02, P-03)', () => {
  it('runs four read-only calls at once; one times out and the four results come back in the order of the model', async () => {
    const t0 = tracker();
    const read = tool('catalog:read', true, (call, { signal }) =>
      t0.around(String(call.input.n), async () => {
        const n = Number(call.input.n);
        // The second call never answers and ignores its signal; the others
        // end in reverse order, the last one first.
        if (n === 2) return never();
        await sleep((5 - n) * 15);
        expect(signal.aborted).toBe(false);
        return { status: 'ok', output: { n } };
      }),
    );
    const t = await kit({
      tools: [read],
      limits: { toolTimeoutSeconds: 0.2 },
      script: [
        [1, 2, 3, 4].map(n =>
          callTool(`m${n}`, 'catalog:read', { n: String(n) }),
        ),
        [say('done')],
      ],
    });

    const { events, outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    // All four started before any of them ended.
    expect(t0.trace.slice(0, 4).every(e => e.startsWith('start:'))).toBe(true);
    const items = await t.read();
    const calls = callsOf(items);
    const results = resultsOf(items);
    expect(results.map(r => r.callId)).toEqual(calls.map(c => c.callId));
    expect(results.map(r => r.status)).toEqual(['ok', 'timeout', 'ok', 'ok']);
    expect(results[1].message).toBe(
      'The tool did not answer within 0.2 seconds.',
    );
    expect(results.map(r => r.output)).toEqual([
      { n: 1 },
      undefined,
      { n: 3 },
      { n: 4 },
    ]);
    // The stream reports the results in the same order as the log.
    const streamed = events.flatMap(event =>
      event.type === 'item.completed' && event.item.kind === 'tool_result'
        ? [event.item.callId]
        : [],
    );
    expect(streamed).toEqual(calls.map(c => c.callId));
    // The next step gets the four results, in order.
    const second = t.model.inputs[1];
    const toolMessages = second.messages.filter(m => m.role === 'tool');
    expect(toolMessages.map(m => (m as { callId: string }).callId)).toEqual(
      calls.map(c => c.callId),
    );
  });

  it('runs at most readConcurrency calls at the same time', async () => {
    const t0 = tracker();
    const read = tool('catalog:read', true, call =>
      t0.around(String(call.input.n), async () => {
        await sleep(10);
        return { status: 'ok', output: {} };
      }),
    );
    const t = await kit({
      tools: [read],
      limits: { readConcurrency: 2 },
      script: [
        [1, 2, 3, 4, 5, 6].map(n =>
          callTool(`m${n}`, 'catalog:read', { n: String(n) }),
        ),
        [say('done')],
      ],
    });

    await t.execute();

    expect(t0.most()).toBe(2);
    expect(t.tools.executed).toHaveLength(6);
    expect(resultsOf(await t.read()).map(r => r.status)).toEqual(
      Array(6).fill('ok'),
    );
  });

  it('writes the result of a call that ended first only after the ones before it', async () => {
    const first = gate();
    const read = tool('catalog:read', true, async call => {
      if (call.input.n === '1') await first.promise;
      return { status: 'ok', output: { n: call.input.n } };
    });
    const t = await kit({
      tools: [read],
      script: [
        [
          callTool('m1', 'catalog:read', { n: '1' }),
          callTool('m2', 'catalog:read', { n: '2' }),
        ],
        [say('done')],
      ],
    });

    const running = t.execute();
    await new Promise(resolve => setTimeout(resolve, 20));
    // The second call ended; its result waits for the first one.
    expect(resultsOf(await t.read())).toHaveLength(0);
    first.open();
    await running;
    expect(resultsOf(await t.read()).map(r => r.output)).toEqual([
      { n: '1' },
      { n: '2' },
    ]);
  });

  it('runs a write between two read-only calls alone, after an approval, with tool_started', async () => {
    const t0 = tracker();
    const read = tool('catalog:read', true, call =>
      t0.around(`read-${call.input.n}`, async () => {
        await sleep(10);
        return { status: 'ok', output: {} };
      }),
    );
    const write = tool('catalog:write', false, () =>
      t0.around('write', async () => {
        await sleep(10);
        return { status: 'ok', output: {} };
      }),
    );
    const t = await kit({
      tools: [read, write],
      script: [
        [
          callTool('m1', 'catalog:read', { n: 'a' }),
          callTool('m2', 'catalog:read', { n: 'b' }),
          callTool('m3', 'catalog:write', {}),
          callTool('m4', 'catalog:read', { n: 'c' }),
          callTool('m5', 'catalog:read', { n: 'd' }),
        ],
        [say('done')],
      ],
    });

    const first = await t.execute();
    expect(first.outcome).toMatchObject({ status: 'waiting_approval' });
    expect(t.tools.executed).toHaveLength(0);
    const writeCall = callsOf(await t.read())[2];
    await t.append({
      kind: 'approval',
      callId: writeCall.callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });

    const second = await t.execute();

    expect(second.outcome).toEqual({ status: 'completed' });
    const writeStart = t0.trace.indexOf('start:write');
    const writeEnd = t0.trace.indexOf('end:write');
    expect(t0.trace.slice(0, writeStart).sort()).toEqual(
      ['end:read-a', 'end:read-b', 'start:read-a', 'start:read-b'].sort(),
    );
    expect(writeEnd).toBe(writeStart + 1);
    expect(
      t0.trace
        .slice(writeEnd + 1)
        .slice(0, 2)
        .sort(),
    ).toEqual(['start:read-c', 'start:read-d'].sort());
    expect(t0.most()).toBe(2);
    const items = await t.read();
    const started = items.findIndex(i => i.kind === 'tool_started');
    const writeResult = items.findIndex(
      i => i.kind === 'tool_result' && i.callId === writeCall.callId,
    );
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(writeResult);
    const calls = callsOf(items);
    expect(resultsOf(items).map(r => r.callId)).toEqual(
      calls.map(c => c.callId),
    );
    expect(completedKinds(second.events)).toContain('tool_started');
  });

  it('runs the allowed calls that needed approval with the others and writes denied for a denied one', async () => {
    const t0 = tracker();
    const read = tool('catalog:read', true, call =>
      t0.around(String(call.input.n), async () => {
        await sleep(10);
        return { status: 'ok', output: {} };
      }),
    );
    const web = tool(
      'web:read',
      true,
      call =>
        t0.around(String(call.input.n), async () => {
          await sleep(10);
          return { status: 'ok', output: {} };
        }),
      { egress: true },
    );
    const t = await kit({
      tools: [read, web],
      script: [
        [
          callTool('m1', 'catalog:read', { n: '1' }),
          callTool('m2', 'web:read', { n: '2' }),
          callTool('m3', 'web:read', { n: '3' }),
        ],
        [say('done')],
      ],
    });
    expect((await t.execute()).outcome).toMatchObject({
      status: 'waiting_approval',
    });
    const [, allowed, denied] = callsOf(await t.read());
    await t.append(
      {
        kind: 'approval',
        callId: allowed.callId,
        decision: 'allow',
        decidedBy: 'user:a',
      },
      {
        kind: 'approval',
        callId: denied.callId,
        decision: 'deny',
        decidedBy: 'user:a',
      },
    );

    await t.execute();

    expect(t0.most()).toBe(2);
    expect(t.tools.executed.map(c => c.input.n)).toEqual(['1', '2']);
    expect(resultsOf(await t.read()).map(r => r.status)).toEqual([
      'ok',
      'ok',
      'denied',
    ]);
  });

  it('runs afterToolCall for each call and writes the changed results in order', async () => {
    const seen: string[] = [];
    const extensions: Extensions = {
      hooks: {
        afterToolCall: [
          async (call, result) => {
            seen.push(call.callId);
            await sleep(call.position === 0 ? 30 : 0);
            return { ...result, output: { changed: call.position } };
          },
        ],
      },
    };
    const read = tool('catalog:read', true, async () => ({
      status: 'ok',
      output: {},
    }));
    const t = await kit({
      tools: [read],
      extensions,
      script: [
        [0, 1, 2].map(n => callTool(`m${n}`, 'catalog:read', {})),
        [say('done')],
      ],
    });

    await t.execute();

    const calls = callsOf(await t.read());
    expect([...seen].sort()).toEqual(calls.map(c => c.callId).sort());
    expect(resultsOf(await t.read()).map(r => r.output)).toEqual([
      { changed: 0 },
      { changed: 1 },
      { changed: 2 },
    ]);
  });
});

describe('executeTools: stops and deadlines with calls at the same time', () => {
  it('keeps the results that ended when the user stops, starts no more calls, and leaves the rest without a result', async () => {
    // Two at a time: 1 hangs, 2 ends, then 3 starts and hangs; 4 waits.
    const read = tool('catalog:read', true, async call => {
      if (call.input.n !== '2') return never();
      return { status: 'ok', output: { n: call.input.n } };
    });
    const t = await kit({
      tools: [read],
      limits: { readConcurrency: 2 },
      script: [
        [1, 2, 3, 4].map(n =>
          callTool(`m${n}`, 'catalog:read', { n: String(n) }),
        ),
      ],
    });

    const running = t.execute();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(resultsOf(await t.read())).toHaveLength(0);
    t.controller.abort();
    const { outcome } = await running;

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(t.tools.executed.map(c => c.input.n)).toEqual(['1', '2', '3']);
    const calls = callsOf(await t.read());
    expect(
      resultsOf(await t.read()).map(r => [r.callId, r.status, r.output]),
    ).toEqual([[calls[1].callId, 'ok', { n: '2' }]]);
  });

  it('ends the run as completed with timeout when the deadline of the run comes first', async () => {
    const read = tool('catalog:read', true, async call => {
      if (call.input.n === '2') return never();
      return { status: 'ok', output: {} };
    });
    const t = await kit({
      tools: [read],
      limits: { runTimeoutSeconds: 0.1, toolTimeoutSeconds: 60 },
      script: [
        [
          callTool('m1', 'catalog:read', { n: '1' }),
          callTool('m2', 'catalog:read', { n: '2' }),
        ],
      ],
    });

    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed', endReason: 'timeout' });
    expect(resultsOf(await t.read()).map(r => r.status)).toEqual(['ok']);
  });

  it('aborts the signals of the calls still running when writing a result fails', async () => {
    const signals: AbortSignal[] = [];
    const read = tool('catalog:read', true, async (call, { signal }) => {
      signals.push(signal);
      if (call.input.n === '2') return never();
      return { status: 'ok', output: {} };
    });
    const t = await kit({
      tools: [read],
      script: [
        [
          callTool('m1', 'catalog:read', { n: '1' }),
          callTool('m2', 'catalog:read', { n: '2' }),
        ],
      ],
    });
    const append = t.items.append.bind(t.items);
    jest.spyOn(t.items, 'append').mockImplementation(async (...args) => {
      if (args[1][0]?.kind === 'tool_result') {
        throw new LeaseLost(args[2].runId);
      }
      return append(...args);
    });

    await expect(t.execute()).rejects.toBeInstanceOf(LeaseLost);

    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('writes timeout for a call that is not read-only and does not run it again', async () => {
    const write = tool('catalog:write', false, () => never());
    const t = await kit({
      tools: [write],
      limits: { toolTimeoutSeconds: 0.05 },
      script: [[callTool('m1', 'catalog:write', {})], [say('done')]],
    });
    await t.execute();
    const [call] = callsOf(await t.read());
    await t.append({
      kind: 'approval',
      callId: call.callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });

    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    const [result] = resultsOf(await t.read());
    expect(result).toMatchObject({
      status: 'timeout',
      message:
        'The tool did not answer within 0.05 seconds. It may still have made its change, and it is not run again.',
    });
    expect(t.tools.executed).toHaveLength(1);
  });
});

describe('executeTools: a change that goes over its time (D-09, P-02)', () => {
  it('does not run the later changes of the step, and still runs the read-only calls after it', async () => {
    const started: string[] = [];
    const slow = tool('catalog:write', false, () => {
      started.push('slow');
      return never();
    });
    const next = tool('catalog:write2', false, async () => {
      started.push('next');
      return { status: 'ok', output: {} };
    });
    const read = tool('catalog:read', true, async () => {
      started.push('read');
      return { status: 'ok', output: {} };
    });
    const t = await kit({
      tools: [slow, next, read],
      limits: { toolTimeoutSeconds: 0.05 },
      script: [
        [
          callTool('m1', 'catalog:write', {}),
          callTool('m2', 'catalog:read', {}),
          callTool('m3', 'catalog:write2', {}),
        ],
        [say('done')],
      ],
    });
    await t.execute();
    const [first, , third] = callsOf(await t.read());
    for (const call of [first, third]) {
      await t.append({
        kind: 'approval',
        callId: call.callId,
        decision: 'allow',
        decidedBy: 'user:a',
      });
    }

    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(started).toEqual(['slow', 'read']);
    const results = resultsOf(await t.read());
    expect(results.map(r => r.status)).toEqual(['timeout', 'ok', 'denied']);
    expect(results[2].message).toBe(
      'Not run: an earlier change of this step did not answer in time and may still be running.',
    );
    const items = await t.read();
    expect(
      items.filter(i => i.kind === 'tool_started').map(i => i.callId),
    ).toEqual([first.callId]);
  });
});

describe('callModel: tool calls per step (P-05)', () => {
  it('denies the calls beyond maxToolCallsPerStep and counts all of them', async () => {
    const read = tool('catalog:read', true, async () => ({
      status: 'ok',
      output: {},
    }));
    const t = await kit({
      tools: [read],
      limits: { maxToolCallsPerStep: 8 },
      script: [
        Array.from({ length: 10 }, (_, n) =>
          callTool(`m${n}`, 'catalog:read', {}),
        ),
        [say('done')],
      ],
    });

    await t.execute();

    const results = resultsOf(await t.read());
    const calls = callsOf(await t.read());
    expect(t.tools.executed).toHaveLength(8);
    const denied = results.filter(r => r.status === 'denied');
    expect(denied.map(r => r.callId)).toEqual(
      calls.slice(8).map(c => c.callId),
    );
    expect(denied.every(r => r.message === 'tool call limit per step')).toBe(
      true,
    );
    expect(t.run.usage[0].toolCallsUsed).toBe(10);
  });

  it('uses the message of the run when the run limit is reached as well', async () => {
    const read = tool('catalog:read', true, async () => ({
      status: 'ok',
      output: {},
    }));
    const t = await kit({
      tools: [read],
      limits: { maxToolCallsPerStep: 2, maxToolCallsPerRun: 1 },
      script: [
        [0, 1, 2].map(n => callTool(`m${n}`, 'catalog:read', {})),
        [say('done')],
      ],
    });

    await t.execute();

    // The refused calls get their results with the calls, before the run.
    expect(resultsOf(await t.read()).map(r => r.message)).toEqual([
      'tool call limit',
      'tool call limit',
      undefined,
    ]);
  });
});

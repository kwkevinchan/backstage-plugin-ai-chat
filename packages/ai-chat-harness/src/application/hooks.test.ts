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

import type { Extensions, StepContext, ToolCall } from './ports/extensions';
import { kit } from '../testing/fixture';
import type { FakeTool } from '../testing/FakeToolGateway';
import { callTool, say } from '../testing/ScriptedModel';

function fakeTool(
  id: string,
  readOnly: boolean,
  execute?: FakeTool['execute'],
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

/** A result whose output refers to itself: it has no JSON. */
function cyclicResult(): unknown {
  const output: Record<string, unknown> = {};
  output.self = output;
  return { status: 'ok', output };
}

/** A promise that never settles, as a hook that hangs gives. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

const readTool = fakeTool('catalog:read', true, call => ({
  status: 'ok',
  output: { seen: call.input },
}));

const writeTool = fakeTool('catalog:write', false, call => ({
  status: 'ok',
  output: { wrote: call.input },
}));

describe('AdvanceRun: hooks (X-05)', () => {
  it('runs beforeModelCall in registration order with StepContext and skips summarize', async () => {
    const trace: string[] = [];
    const seenCtx: StepContext[] = [];

    const extensions: Extensions = {
      hooks: {
        beforeModelCall: [
          ctx => {
            trace.push(`before-1:step=${ctx.step}`);
            seenCtx.push(ctx);
          },
          async ctx => {
            trace.push(`before-2:step=${ctx.step}`);
          },
        ],
      },
    };

    const longLog = [
      ...Array.from({ length: 4 }, (_, i) => [
        { kind: 'user_message' as const, text: `old-question-${i + 1}` },
        {
          kind: 'agent_message' as const,
          text: `old conversation detail ${i + 1} `.repeat(60),
        },
      ]).flat(),
      { kind: 'user_message' as const, text: 'recent-question-1' },
      { kind: 'agent_message' as const, text: 'recent-answer-1' },
      { kind: 'user_message' as const, text: 'recent-question-2' },
      { kind: 'agent_message' as const, text: 'recent-answer-2' },
      { kind: 'user_message' as const, text: 'Check catalog' },
    ];

    const h = await kit({
      tools: [readTool],
      log: longLog,
      budget: { tokenBudget: 700, keepRecentSteps: 2 },
      script: [
        [say('Short summary.')],
        [callTool('m1', 'catalog:read', { q: 'a' })],
        [say('Done.')],
      ],
      extensions,
    });

    const { events, outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(events.some(e => e.type === 'summary.started')).toBe(true);
    // `summarize` is not a model step and must not trigger `beforeModelCall`.
    expect(seenCtx).toHaveLength(2);
    expect(seenCtx[0]).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'default',
      step: 1,
    });
    expect(seenCtx[0].signal).toBeInstanceOf(AbortSignal);
    expect(seenCtx[1].step).toBe(2);
    expect(trace).toEqual([
      'before-1:step=1',
      'before-2:step=1',
      'before-1:step=2',
      'before-2:step=2',
    ]);
  });

  it('gives each hook call its own copy of the principal', async () => {
    const seen: unknown[] = [];
    const h = await kit({
      tools: [readTool],
      log: [{ kind: 'user_message', text: 'Check' }],
      script: [[callTool('m1', 'catalog:read', {})], [say('Done.')]],
      extensions: {
        hooks: {
          beforeModelCall: [
            ctx => {
              seen.push(ctx.principal);
              (ctx.principal as { user: string }).user = 'user:changed';
            },
            ctx => {
              seen.push(ctx.principal);
            },
          ],
          beforeToolCall: [
            (_call, ctx) => {
              seen.push(ctx.principal);
              return { action: 'continue' };
            },
          ],
        },
      },
    });

    const request = h.request();
    expect((await h.execute()).outcome).toEqual({ status: 'completed' });
    // Step 1: two model hooks and one tool hook; step 2: two model hooks.
    expect(seen).toHaveLength(5);
    expect(seen.slice(1)).toEqual([
      { user: 'user:a' },
      { user: 'user:a' },
      { user: 'user:changed' },
      { user: 'user:a' },
    ]);
    expect(seen[1]).not.toBe(seen[0]);
    expect(request.ctx.principal).toEqual({ user: 'user:a' });
  });

  it('fails closed when beforeModelCall throws: skips model call and fails run', async () => {
    const model = jest.fn();

    const h = await kit({
      log: [{ kind: 'user_message', text: 'Hi' }],
      script: [
        () => {
          model();
          return [say('should not happen')];
        },
      ],
      extensions: {
        hooks: {
          beforeModelCall: [
            () => {
              throw new Error('rate quota exhausted');
            },
          ],
        },
      },
    });

    const { events, outcome } = await h.execute();
    expect(model).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'The model call failed.',
    });
    expect((outcome as { cause?: Error }).cause?.message).toBe(
      'rate quota exhausted',
    );
    expect(events.some(e => e.type === 'step.started')).toBe(false);
  });

  it('never relaxes ask policy: beforeToolCall returning continue keeps approval requirement', async () => {
    const h = await kit({
      tools: [writeTool],
      log: [{ kind: 'user_message', text: 'Write thing' }],
      script: [
        [callTool('m1', 'catalog:write', { id: 'x' })],
        [say('Written.')],
      ],
      extensions: {
        hooks: {
          beforeToolCall: [() => ({ action: 'continue' })],
        },
      },
    });

    const first = await h.execute();
    expect(first.outcome.status).toBe('waiting_approval');

    const pending = (first.outcome as { pending: ToolCall[] }).pending;
    await h.append({
      kind: 'approval',
      callId: pending[0].callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });

    const second = await h.execute();
    expect(second.outcome).toEqual({ status: 'completed' });
  });

  it('keeps the approval of a read-only tool the administrator sets to ask, and of an egress tool, when the hook says continue', async () => {
    const executed: string[] = [];
    const askedRead = fakeTool('catalog:read', true, () => {
      executed.push('read');
      return { status: 'ok' };
    });
    const egressRead = fakeTool(
      'web:fetch',
      true,
      () => {
        executed.push('fetch');
        return { status: 'ok' };
      },
      { egress: true },
    );
    const h = await kit({
      tools: [askedRead, egressRead],
      policy: { byTool: { 'catalog:read': 'ask' } },
      log: [{ kind: 'user_message', text: 'Read' }],
      script: [
        [callTool('m1', 'catalog:read', {}), callTool('m2', 'web:fetch', {})],
        [say('Done.')],
      ],
      extensions: {
        hooks: { beforeToolCall: [() => ({ action: 'continue' })] },
      },
    });

    const first = await h.execute();
    expect(first.outcome.status).toBe('waiting_approval');
    const pending = (first.outcome as { pending: ToolCall[] }).pending;
    expect(pending.map(call => call.toolId)).toEqual([
      'catalog:read',
      'web:fetch',
    ]);
    const calls = (await h.read()).filter(i => i.kind === 'tool_call');
    expect(calls.map(call => call.policy)).toEqual(['ask', 'ask']);
    expect(executed).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['an unknown action', { action: 'allow' }],
    ['a string', 'continue'],
  ])(
    'denies the call when beforeToolCall returns %s',
    async (_name, decision) => {
      const executed: string[] = [];
      const tool = fakeTool('catalog:read', true, () => {
        executed.push('read');
        return { status: 'ok' };
      });
      const h = await kit({
        tools: [tool],
        log: [{ kind: 'user_message', text: 'Read' }],
        script: [[callTool('m1', 'catalog:read', {})], [say('Done.')]],
        extensions: {
          hooks: { beforeToolCall: [() => decision as never] },
        },
      });

      expect((await h.execute()).outcome).toEqual({ status: 'completed' });
      expect(executed).toEqual([]);
      const result = (await h.read()).find(i => i.kind === 'tool_result');
      expect(result).toMatchObject({
        status: 'denied',
        message: 'Denied by hook.',
      });
    },
  );

  it('uses the fixed reason when a deny has no reason', async () => {
    const h = await kit({
      tools: [readTool],
      log: [{ kind: 'user_message', text: 'Read' }],
      script: [[callTool('m1', 'catalog:read', {})], [say('Done.')]],
      extensions: {
        hooks: {
          beforeToolCall: [() => ({ action: 'deny', reason: ' ' })],
        },
      },
    });

    await h.execute();
    const result = (await h.read()).find(i => i.kind === 'tool_result');
    expect(result).toMatchObject({
      status: 'denied',
      message: 'Denied by hook.',
    });
  });

  it('ends the run cancelled when it stops while beforeModelCall hangs', async () => {
    const model = jest.fn();
    let called!: () => void;
    const started = new Promise<void>(resolve => {
      called = resolve;
    });
    const h = await kit({
      log: [{ kind: 'user_message', text: 'Hi' }],
      script: [
        () => {
          model();
          return [say('should not happen')];
        },
      ],
      extensions: {
        hooks: {
          beforeModelCall: [
            () => {
              called();
              return never();
            },
          ],
        },
      },
    });

    const running = h.execute();
    await started;
    h.controller.abort();
    expect((await running).outcome).toEqual({ status: 'cancelled' });
    expect(model).not.toHaveBeenCalled();
  });

  it('ends the run cancelled when it stops while beforeToolCall hangs, and runs nothing', async () => {
    let called!: () => void;
    const started = new Promise<void>(resolve => {
      called = resolve;
    });
    const executed: string[] = [];
    const tool = fakeTool('catalog:read', true, () => {
      executed.push('read');
      return { status: 'ok' };
    });
    const h = await kit({
      tools: [tool],
      log: [{ kind: 'user_message', text: 'Read' }],
      script: [[callTool('m1', 'catalog:read', {})], [say('Done.')]],
      extensions: {
        hooks: {
          beforeToolCall: [
            () => {
              called();
              return never();
            },
          ],
        },
      },
    });

    const running = h.execute();
    await started;
    h.controller.abort();
    expect((await running).outcome).toEqual({ status: 'cancelled' });
    expect(executed).toEqual([]);
    expect((await h.kinds()).includes('tool_call')).toBe(false);
  });

  it('stores an error result when the run stops while afterToolCall runs, after the tool ran', async () => {
    let called!: () => void;
    const started = new Promise<void>(resolve => {
      called = resolve;
    });
    let release!: () => void;
    const late = new Promise<void>(resolve => {
      release = resolve;
    });
    const h = await kit({
      tools: [writeTool],
      log: [{ kind: 'user_message', text: 'Write' }],
      script: [[callTool('m1', 'catalog:write', { id: 'x' })], [say('Done.')]],
      extensions: {
        hooks: {
          afterToolCall: [
            async (_call, result) => {
              called();
              await late;
              return result;
            },
          ],
        },
      },
    });

    const first = await h.execute();
    const pending = (first.outcome as { pending: ToolCall[] }).pending;
    await h.append({
      kind: 'approval',
      callId: pending[0].callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });
    const running = h.execute();
    await started;
    h.controller.abort();
    const { outcome } = await running;
    release();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(h.tools.executed).toHaveLength(1);
    const results = (await h.read()).filter(i => i.kind === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'error',
      message: 'A hook failed after the tool call.',
    });
    expect((results[0] as { output?: unknown }).output).toBeUndefined();
  });

  it('stores an error result when the run stops while afterToolCall hangs', async () => {
    let called!: () => void;
    const started = new Promise<void>(resolve => {
      called = resolve;
    });
    const h = await kit({
      tools: [readTool],
      log: [{ kind: 'user_message', text: 'Read' }],
      script: [[callTool('m1', 'catalog:read', {})], [say('Done.')]],
      extensions: {
        hooks: {
          afterToolCall: [
            () => {
              called();
              return never();
            },
          ],
        },
      },
    });

    const running = h.execute();
    await started;
    h.controller.abort();
    expect((await running).outcome).toEqual({ status: 'cancelled' });
    const result = (await h.read()).find(i => i.kind === 'tool_result');
    expect(result).toMatchObject({
      status: 'error',
      message: 'A hook failed after the tool call.',
    });
  });

  it('tightens allow to ask, prevents relaxing ask back to allow, and denies on deny or exception without halting the run', async () => {
    const executed: string[] = [];
    const customRead = fakeTool('catalog:read', true, call => {
      executed.push(`read:${String(call.input.tag)}`);
      return { status: 'ok', output: { tag: call.input.tag } };
    });
    const otherRead = fakeTool('catalog:list', true, call => {
      executed.push(`list:${String(call.input.tag)}`);
      return { status: 'ok', output: { list: true } };
    });

    const hookOrder: string[] = [];
    const h = await kit({
      tools: [customRead, otherRead, writeTool],
      log: [{ kind: 'user_message', text: 'Run tools' }],
      script: [
        [
          callTool('m1', 'catalog:read', { tag: 'tighten' }),
          callTool('m2', 'catalog:list', { tag: 'boom' }),
          callTool('m3', 'catalog:write', { tag: 'deny-ask' }),
        ],
        [say('Finished step.')],
      ],
      extensions: {
        hooks: {
          beforeToolCall: [
            call => {
              hookOrder.push(`h1:${call.toolId}`);
              // Mutate cloned input to verify stored input is isolated.
              call.input.mutated = true;
              if (call.toolId === 'catalog:read') return { action: 'ask' };
              if (call.toolId === 'catalog:list') {
                throw new Error('hook crashed with internal details');
              }
              return { action: 'deny', reason: 'Blocked by policy hook' };
            },
            call => {
              hookOrder.push(`h2:${call.toolId}`);
              return { action: 'continue' };
            },
          ],
        },
      },
    });

    const first = await h.execute();
    expect(first.outcome.status).toBe('waiting_approval');
    // Hook 2 did NOT run for denied/throwing `catalog:list` or `deny`ed `catalog:write`.
    expect(hookOrder).toEqual([
      'h1:catalog:read',
      'h2:catalog:read',
      'h1:catalog:list',
      'h1:catalog:write',
    ]);
    expect(executed).toEqual([]);

    const log = await h.items.read('session-1');
    const results = log.filter(i => i.kind === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      kind: 'tool_result',
      status: 'denied',
      message: 'Denied by hook.',
    });
    expect(results[1]).toMatchObject({
      kind: 'tool_result',
      status: 'denied',
      message: 'Blocked by policy hook',
    });

    const pending = (first.outcome as { pending: ToolCall[] }).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].toolId).toBe('catalog:read');
    // Mutation inside hook must NOT leak into stored tool_call input.
    expect(pending[0].input).toEqual({ tag: 'tighten' });

    await h.append({
      kind: 'approval',
      callId: pending[0].callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });
    const second = await h.execute();
    expect(second.outcome).toEqual({ status: 'completed' });
    expect(executed).toEqual(['read:tighten']);
  });

  it('pipelines afterToolCall only for executed calls, masks output identically in log and stream, and fails closed on throw', async () => {
    const afterSeen: string[] = [];
    const maskedTool = fakeTool('catalog:secret', true, () => ({
      status: 'ok',
      output: { token: 'secret-value' },
    }));

    const h1 = await kit({
      tools: [maskedTool, readTool],
      policy: { byTool: { 'catalog:read': 'deny' } },
      log: [{ kind: 'user_message', text: 'Run' }],
      script: [
        [
          callTool('m1', 'catalog:secret', {}),
          callTool('m2', 'catalog:read', {}),
        ],
        [say('Done')],
      ],
      extensions: {
        hooks: {
          afterToolCall: [
            (call, result) => {
              afterSeen.push(`h1:${call.toolId}`);
              call.input.tampered = true;
              return {
                ...result,
                output: { token: '[REDACTED]' },
              };
            },
            (call, result) => {
              afterSeen.push(`h2:${call.toolId}`);
              return {
                ...result,
                output: {
                  ...(result.output as Record<string, unknown>),
                  audited: true,
                },
              };
            },
          ],
        },
      },
    });

    const res1 = await h1.execute();
    expect(res1.outcome).toEqual({ status: 'completed' });
    // Denied tool did not run, so afterToolCall ran only for catalog:secret.
    expect(afterSeen).toEqual(['h1:catalog:secret', 'h2:catalog:secret']);
    const streamedResult = res1.events.find(
      e =>
        e.type === 'item.completed' &&
        e.item.kind === 'tool_result' &&
        e.item.status === 'ok',
    );
    const storedLog = await h1.items.read('session-1');
    const storedResult = storedLog.find(
      i => i.kind === 'tool_result' && i.status === 'ok',
    );
    expect(storedResult).toMatchObject({
      status: 'ok',
      output: { token: '[REDACTED]', audited: true },
    });
    expect((streamedResult as { item: unknown }).item).toEqual(storedResult);
    // The hook changed its copy of the call: the stored call stays as it was.
    const storedCalls = storedLog.filter(i => i.kind === 'tool_call');
    expect(storedCalls.map(call => call.input)).toEqual([{}, {}]);

    // Fail closed if afterToolCall throws or returns an invalid result: raw secret must not leak.
    const h2 = await kit({
      tools: [maskedTool],
      log: [{ kind: 'user_message', text: 'Run fail hook' }],
      script: [[callTool('m1', 'catalog:secret', {})], [say('Done anyway')]],
      extensions: {
        hooks: {
          afterToolCall: [
            () => {
              throw new Error('masker crashed: secret-value');
            },
          ],
        },
      },
    });

    const res2 = await h2.execute();
    expect(res2.outcome).toEqual({ status: 'completed' });
    const failedStored = (await h2.items.read('session-1')).find(
      i => i.kind === 'tool_result',
    );
    expect(failedStored).toMatchObject({
      kind: 'tool_result',
      status: 'error',
      message: 'A hook failed after the tool call.',
    });
    expect((failedStored as { output?: unknown }).output).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    [
      'an unknown status',
      { status: 'done', output: { token: 'secret-value' } },
    ],
    [
      'a truncated flag that is not a boolean',
      { status: 'ok', truncated: 'yes' },
    ],
    ['a message that is not a string', { status: 'ok', message: 42 }],
    ['an array', [{ status: 'ok' }]],
    ['an output with a BigInt', { status: 'ok', output: { n: BigInt(1) } }],
    ['an output with a cycle', cyclicResult()],
  ])(
    'stores an error result when afterToolCall returns %s',
    async (_name, returned) => {
      const secretTool = fakeTool('catalog:secret', true, () => ({
        status: 'ok',
        output: { token: 'secret-value' },
      }));
      const h = await kit({
        tools: [secretTool],
        log: [{ kind: 'user_message', text: 'Run' }],
        script: [[callTool('m1', 'catalog:secret', {})], [say('Done')]],
        extensions: {
          hooks: { afterToolCall: [() => returned as never] },
        },
      });

      expect((await h.execute()).outcome).toEqual({ status: 'completed' });
      const stored = (await h.read()).find(i => i.kind === 'tool_result');
      expect(stored).toMatchObject({
        status: 'error',
        message: 'A hook failed after the tool call.',
      });
      expect((stored as { output?: unknown }).output).toBeUndefined();
    },
  );
});

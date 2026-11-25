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

import type {
  Extensions,
  RunSummary,
  StepContext,
  ToolCall,
} from './ports/extensions';
import { kit } from '../testing/fixture';
import type { FakeTool } from '../testing/FakeToolGateway';
import { callTool, say } from '../testing/ScriptedModel';

function fakeTool(
  id: string,
  readOnly: boolean,
  execute?: FakeTool['execute'],
): FakeTool {
  return {
    descriptor: {
      id,
      description: `The tool ${id}`,
      inputSchema: { type: 'object' },
      schemaHash: `hash-${id}`,
      readOnly,
    },
    execute,
  };
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
  it('runs beforeModelCall in registration order with StepContext, skips summarize, and runs onRunEnd once at terminal end', async () => {
    const trace: string[] = [];
    const seenCtx: StepContext[] = [];
    const summaries: RunSummary[] = [];

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
        onRunEnd: [
          summary => {
            trace.push(`end-1:${summary.outcome.status}`);
            summaries.push(summary);
          },
          summary => {
            trace.push(`end-2:${summary.outcome.status}`);
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
      'end-1:completed',
      'end-2:completed',
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'default',
      principal: { user: 'user:a' },
      outcome: { status: 'completed' },
      usage: { stepsUsed: 2, toolCallsUsed: 1 },
    });
  });

  it('fails closed when beforeModelCall throws: skips model call, fails run, and fires onRunEnd', async () => {
    const model = jest.fn();
    const summaries: RunSummary[] = [];

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
          onRunEnd: [
            summary => {
              summaries.push(summary);
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
    expect(summaries).toHaveLength(1);
    expect(summaries[0].outcome.status).toBe('failed');
  });

  it('never relaxes ask policy: beforeToolCall returning continue keeps approval requirement and onRunEnd does not fire on wait', async () => {
    const summaries: RunSummary[] = [];
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
          onRunEnd: [
            summary => {
              summaries.push(summary);
            },
          ],
        },
      },
    });

    const first = await h.execute();
    expect(first.outcome.status).toBe('waiting_approval');
    expect(summaries).toHaveLength(0);

    const pending = (first.outcome as { pending: ToolCall[] }).pending;
    await h.append({
      kind: 'approval',
      callId: pending[0].callId,
      decision: 'allow',
      decidedBy: 'user:a',
    });

    const second = await h.execute();
    expect(second.outcome).toEqual({ status: 'completed' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].outcome).toEqual({ status: 'completed' });
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

  it('isolates errors across multiple onRunEnd hooks without changing completed outcome', async () => {
    const called: string[] = [];
    const h = await kit({
      log: [{ kind: 'user_message', text: 'Hello' }],
      script: [[say('World')]],
      extensions: {
        hooks: {
          onRunEnd: [
            () => {
              called.push('first');
              throw new Error('metrics sink down');
            },
            summary => {
              called.push(`second:${summary.outcome.status}`);
            },
          ],
        },
      },
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(called).toEqual(['first', 'second:completed']);
  });
});

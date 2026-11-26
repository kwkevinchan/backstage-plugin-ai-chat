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

import { mockServices } from '@backstage/backend-test-utils';
import {
  callTool,
  say,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import type {
  Extensions,
  ItemLog,
  RunSummary,
} from '@kwkevinchan/ai-chat-harness';
import { AiChatHarnessRegistry } from '../adapters/backstage/AiChatHarnessRegistry';
import { createWorld, drain, jane, until } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;

describe('harness hooks through host and supervisor (X-05)', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  beforeEach(async () => {
    world = await createWorld();
  });

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<World['backend']>) {
    const b = world.backend(...args);
    open.push(b.supervisor);
    return b;
  }

  it('tightens read-only tools to ask, keeps write approvals when hook says continue, transforms output identically in DB & stream, and delays onRunEnd until terminal completion', async () => {
    const runEnds: RunSummary[] = [];
    const seenBefore: string[] = [];

    const extensions: Extensions = {
      hooks: {
        beforeToolCall: [
          call => {
            seenBefore.push(call.toolId);
            if (call.toolId === 'demo:read') return { action: 'ask' };
            return { action: 'continue' };
          },
        ],
        afterToolCall: [
          (_call, result) => ({
            ...result,
            output: {
              ...(result.output as Record<string, unknown>),
              hookTag: 'redacted',
            },
          }),
        ],
        onRunEnd: [
          summary => {
            runEnds.push(summary);
          },
        ],
      },
    };

    const a = backend(
      [
        [
          callTool('m1', 'demo:read', { name: 'r1' }),
          callTool('m2', 'demo:write', { name: 'w1' }),
        ],
        [say('All done.')],
      ],
      { extensions },
    );

    const session = await world.newSession();
    const firstHandle = await a.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'Run both tools',
    });
    const firstEvents = await drain(firstHandle);

    expect(firstEvents[firstEvents.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'waiting_approval' },
    });
    // `waiting_approval` is not a terminal outcome: onRunEnd must not run yet,
    // and neither tool may have executed before decisions.
    expect(runEnds).toHaveLength(0);
    expect(world.actions.count('demo:read')).toBe(0);
    expect(world.actions.count('demo:write')).toBe(0);
    expect(seenBefore).toEqual(['demo:read', 'demo:write']);

    const itemsAfterFirst = await world.items.read(session.id);
    const pendingCalls = itemsAfterFirst.filter(i => i.kind === 'tool_call');
    expect(pendingCalls).toHaveLength(2);
    expect(pendingCalls[0].policy).toBe('ask');
    expect(pendingCalls[1].policy).toBe('ask');

    await a.useCases.decideApproval.execute({
      principal: jane,
      sessionId: session.id,
      callId: pendingCalls[0].callId,
      decision: 'allow',
    });
    const finalRes = await a.useCases.decideApproval.execute({
      principal: jane,
      sessionId: session.id,
      callId: pendingCalls[1].callId,
      decision: 'allow',
    });
    expect(finalRes.run).toBeDefined();
    const resumedEvents = await drain(finalRes.run!);

    expect(world.actions.count('demo:read')).toBe(1);
    expect(world.actions.count('demo:write')).toBe(1);

    const finalItems = await world.items.read(session.id);
    const storedResults = finalItems.filter(i => i.kind === 'tool_result');
    expect(storedResults[0]).toMatchObject({
      status: 'ok',
      output: { things: ['a'], hookTag: 'redacted' },
    });
    expect(storedResults[1]).toMatchObject({
      status: 'ok',
      output: { changed: true, hookTag: 'redacted' },
    });

    const streamedResults = resumedEvents.filter(
      e => e.type === 'item.completed' && e.item.kind === 'tool_result',
    );
    expect(streamedResults.map(e => (e as { item: unknown }).item)).toEqual(
      storedResults,
    );

    await until(() => runEnds.length === 1);
    expect(runEnds[0]).toEqual({
      sessionId: session.id,
      runId: firstHandle.runId,
      agentId: 'default',
      userRef: jane.userRef,
      status: 'completed',
      usage: expect.objectContaining({ stepsUsed: 2, toolCallsUsed: 2 }),
    });
    // The summary has the user, not the credentials of the user.
    expect(JSON.stringify(runEnds[0])).not.toContain('credentials');
  });

  it('denies a call when beforeToolCall throws and does not fire onRunEnd prematurely during UnreadMessages retry', async () => {
    const runEnds: RunSummary[] = [];
    let inserted = false;
    let sessionId = '';
    const b: ReturnType<typeof backend> = backend(
      [
        [callTool('m1', 'demo:read', { name: 'secret' })],
        [say('Answer before insert.')],
        [say('Answer after reading insert.')],
      ],
      {
        extensions: {
          hooks: {
            beforeToolCall: [
              () => {
                throw new Error('sensitive internal failure');
              },
            ],
            onRunEnd: [
              summary => {
                runEnds.push(summary);
              },
            ],
          },
        },
        aroundTransition: async ({ runId, to }, call) => {
          if (to === 'completed' && !inserted) {
            inserted = true;
            await b.useCases.insertMessage.execute({
              principal: jane,
              sessionId,
              runId,
              text: 'Wait, check one more thing',
            });
          }
          return call();
        },
      },
    );

    const session = await world.newSession();
    sessionId = session.id;
    const handle = await b.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'Go',
    });
    const events = await drain(handle);

    expect(events[events.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    expect(world.actions.count('demo:read')).toBe(0);
    const results = (await world.items.read(session.id)).filter(
      i => i.kind === 'tool_result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'denied',
      message: 'Denied by hook.',
    });
    expect(JSON.stringify(results[0])).not.toContain('sensitive');
    expect(inserted).toBe(true);
    // Retried once for UnreadMessages, so onRunEnd fires ONLY once at the true terminal end.
    await until(() => runEnds.length === 1);
    await settleHooks();
    expect(runEnds).toHaveLength(1);
    expect(runEnds[0].status).toBe('completed');
  });

  describe('onRunEnd: once, with the status the host stored', () => {
    const writeCall = callTool('m1', 'demo:write', { name: 'x' });

    function recorder() {
      const ends: RunSummary[] = [];
      const extensions: Extensions = {
        hooks: { onRunEnd: [summary => void ends.push(summary)] },
      };
      return { ends, extensions };
    }

    it('fires cancelled when the user stops a run that waits for an approval', async () => {
      const { ends, extensions } = recorder();
      const a = backend([[writeCall]], { extensions });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(handle);
      await settleHooks();
      // Waiting for an approval is no end.
      expect(ends).toHaveLength(0);

      await a.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      await until(() => ends.length === 1);
      await settleHooks();
      expect(ends).toEqual([
        expect.objectContaining({
          runId: handle.runId,
          userRef: jane.userRef,
          status: 'cancelled',
          endReason: 'user',
        }),
      ]);
    });

    it.each<['before' | 'after']>([['before'], ['after']])(
      'fires once when another backend stores the stop %s the wait for an approval is written',
      async when => {
        const { ends, extensions } = recorder();
        const session = await world.newSession();
        const b = backend([], { extensions });
        let done = false;
        const a = backend([[writeCall]], {
          extensions,
          aroundTransition: async ({ runId, to }, call) => {
            if (to !== 'waiting_approval' || done) return call();
            done = true;
            const stop = () =>
              b.useCases.cancelRun.execute({
                principal: jane,
                sessionId: session.id,
                runId,
              });
            if (when === 'before') await stop();
            const result = await call();
            if (when === 'after') await stop();
            return result;
          },
        });
        const handle = await a.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'go',
        });
        await handle.done;
        expect((await world.runRow(handle.runId)).status).toBe('cancelled');
        await until(() => ends.length >= 1);
        await settleHooks();
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({
          status: 'cancelled',
          endReason: 'user',
        });
      },
    );

    it('fires cancelled when the user stops a running run', async () => {
      const { ends, extensions } = recorder();
      const a = backend([waitForAbort], { extensions });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => a.model.inputs.length === 1);
      await a.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      await handle.done;
      await until(() => ends.length === 1);
      expect(ends[0]).toMatchObject({ status: 'cancelled', endReason: 'user' });
    });

    it('fires completed with the limit as the end reason', async () => {
      const limited = await createWorld({ limits: { maxSteps: 1 } });
      try {
        const { ends, extensions } = recorder();
        const a = limited.backend(
          [[callTool('m1', 'demo:read', { name: 'r' })], [say('never')]],
          { extensions },
        );
        open.push(a.supervisor);
        const session = await limited.newSession();
        const handle = await a.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'go',
        });
        await drain(handle);
        await until(() => ends.length === 1);
        expect(ends[0]).toMatchObject({
          status: 'completed',
          endReason: 'max_steps',
        });
        await a.supervisor.shutdown(0);
      } finally {
        await limited.cleanup();
      }
    });

    it('fires failed when a port throws', async () => {
      const { ends, extensions } = recorder();
      const a = backend([[say('hi')]], {
        extensions,
        items: (inner: ItemLog): ItemLog => ({
          read: (...args) => inner.read(...args),
          latestPlanUpdate: (...args) => inner.latestPlanUpdate(...args),
          append: async (sessionId, drafts, fence) => {
            if (drafts.some(d => d.kind === 'agent_message')) {
              throw new Error('database is down');
            }
            return inner.append(sessionId, drafts, fence);
          },
        }),
      });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(handle);
      await until(() => ends.length === 1);
      await settleHooks();
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ status: 'failed', endReason: 'error' });
    });

    it('fires expired, not cancelled, when the shutdown ends the run', async () => {
      const { ends, extensions } = recorder();
      const a = backend([waitForAbort], { extensions });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => a.model.inputs.length === 1);
      await a.supervisor.shutdown(30);
      await handle.done;
      expect((await world.runRow(handle.runId)).status).toBe('expired');
      await until(() => ends.length === 1);
      await settleHooks();
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({
        status: 'expired',
        endReason: 'shutdown',
      });
    });

    it('does not fire on a backend that lost the lease', async () => {
      const { ends, extensions } = recorder();
      const a = backend([waitForAbort], { extensions });
      const b = backend([[say('x')]], { extensions });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await until(() => a.model.inputs.length === 1);
      world.clock.advance(31);
      await b.runs.acquireLease(handle.runId);
      a.supervisor.cancel(handle.runId);
      await handle.done;
      await settleHooks();
      expect(ends).toHaveLength(0);
    });

    it('fires expired once when ExpireStaleRuns of two backends ends a run whose backend stopped', async () => {
      const { ends, extensions } = recorder();
      const crashed = backend([waitForAbort]);
      const b = backend([], { extensions });
      const c = backend([], { extensions });
      const session = await world.newSession();
      const handle = await crashed.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => crashed.model.inputs.length === 1);
      world.clock.advance(31);

      const [fromB, fromC] = await Promise.all([
        b.useCases.expireStaleRuns.execute(),
        c.useCases.expireStaleRuns.execute(),
      ]);
      expect([...fromB, ...fromC]).toEqual([handle.runId]);
      await until(() => ends.length === 1);
      await settleHooks();
      expect(ends).toEqual([
        expect.objectContaining({
          runId: handle.runId,
          agentId: 'default',
          userRef: jane.userRef,
          status: 'expired',
          endReason: 'lease_expired',
        }),
      ]);
    });

    it('fires failed when a run that waited for an approval cannot be carried on', async () => {
      const { ends, extensions } = recorder();
      const a = backend([[writeCall]], { extensions });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      const events = await drain(handle);
      const ended = events[events.length - 1] as {
        outcome: { pending: { callId: string }[] };
      };
      // The agent of the session is gone, so the loop cannot start again.
      await world.knex('sessions').where({ id: session.id }).update({
        agent_id: 'removed',
      });
      await expect(
        a.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId: ended.outcome.pending[0].callId,
          decision: 'allow',
        }),
      ).rejects.toThrow();
      expect((await world.runRow(handle.runId)).status).toBe('failed');
      await until(() => ends.length === 1);
      expect(ends[0]).toMatchObject({
        runId: handle.runId,
        agentId: 'removed',
        status: 'failed',
        endReason: 'not_started',
      });
    });

    it('lets the shutdown wait for an onRunEnd hook that is slow', async () => {
      let finished = false;
      const a = backend([[say('one')]], {
        extensions: {
          hooks: {
            onRunEnd: [
              async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                finished = true;
              },
            ],
          },
        },
      });
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(handle);
      expect(finished).toBe(false);
      await a.supervisor.shutdown(0);
      expect(finished).toBe(true);
    });

    it('ends the run while an onRunEnd hook hangs, and the next run starts', async () => {
      const calls: string[] = [];
      const releases: (() => void)[] = [];
      const a = backend([[say('one')], [say('two')]], {
        extensions: {
          hooks: {
            onRunEnd: [
              summary => {
                calls.push(summary.status);
                return new Promise<void>(resolve => releases.push(resolve));
              },
            ],
          },
        },
      });
      const session = await world.newSession();
      const first = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(first);
      expect((await world.runRow(first.runId)).status).toBe('completed');
      const second = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'again',
      });
      await drain(second);
      await until(() => calls.length === 2);
      // The shutdown of `afterEach` would wait for them.
      for (const release of releases) release();
    });
  });

  describe('a hook that does not answer', () => {
    it('lets a stop end the run, and the lease is no longer renewed', async () => {
      let called = false;
      const a = backend(
        [[callTool('m1', 'demo:read', { name: 'r' })], [say('never')]],
        {
          heartbeatMs: 10,
          extensions: {
            hooks: {
              beforeToolCall: [
                () => {
                  called = true;
                  return new Promise(() => undefined);
                },
              ],
            },
          },
        },
      );
      const heartbeat = jest.spyOn(a.runs, 'heartbeat');
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await until(() => called);
      await a.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      await handle.done;
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('cancelled');
      expect(row.active_session_id).toBeNull();
      expect(world.actions.count('demo:read')).toBe(0);

      const renewals = heartbeat.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(heartbeat.mock.calls.length).toBe(renewals);
    });
  });

  describe('the hooks of the registry', () => {
    it('cuts output that afterToolCall made longer than maxToolOutputChars', async () => {
      const registry = new AiChatHarnessRegistry();
      registry.addHook('afterToolCall', (_call, result) => ({
        ...result,
        output: { padding: 'x'.repeat(500) },
      }));
      const a = backend(
        [[callTool('m1', 'demo:read', { name: 'r' })], [say('Done.')]],
        {
          extensions: registry.extensions({
            logger: mockServices.logger.mock(),
            maxToolOutputChars: 100,
          }),
        },
      );
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      const events = await drain(handle);
      const stored = (await world.items.read(session.id)).find(
        i => i.kind === 'tool_result',
      );
      expect(stored).toMatchObject({ status: 'ok', truncated: true });
      expect(
        JSON.stringify((stored as { output?: unknown }).output).length,
      ).toBeLessThanOrEqual(100);
      const streamed = events.find(
        e => e.type === 'item.completed' && e.item.kind === 'tool_result',
      );
      expect((streamed as { item: unknown }).item).toEqual(stored);
    });
  });
});

/** Gives hooks that run in the background the time to run. */
function settleHooks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}

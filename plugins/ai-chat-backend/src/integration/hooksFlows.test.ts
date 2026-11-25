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

import { callTool, say } from '@kwkevinchan/ai-chat-harness/testing';
import type { Extensions, RunSummary } from '@kwkevinchan/ai-chat-harness';
import { createWorld, drain, jane } from './__testUtils__';

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

    expect(runEnds).toHaveLength(1);
    expect(runEnds[0]).toMatchObject({
      sessionId: session.id,
      runId: firstHandle.runId,
      agentId: 'default',
      outcome: { status: 'completed' },
    });
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
    expect(runEnds).toHaveLength(1);
    expect(runEnds[0].outcome).toEqual({ status: 'completed' });
  });
});

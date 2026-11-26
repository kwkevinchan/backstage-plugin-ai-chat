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
import type { Item } from '@kwkevinchan/ai-chat-harness';
import type { Principal } from '../domain';
import { createWorld, drain, jane, mallory } from './__testUtils__';

const QUOTA_MESSAGE = (n: number) =>
  `Not run: you reached the limit of ${n} changes per minute. Try again in a minute.`;

describe('the quota of changes per user and minute (T-10)', () => {
  let world: Awaited<ReturnType<typeof createWorld>>;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<typeof world.backend>) {
    const b = world.backend(...args);
    open.push(b.supervisor);
    return b;
  }

  /**
   * Sends a message whose first step asks for `calls`, decides each call as
   * `decisions` says (allow when not given), and runs the run to its end.
   */
  async function run(
    b: ReturnType<typeof backend>,
    options: { principal?: Principal; decisions?: ('allow' | 'deny')[] } = {},
  ) {
    const principal = options.principal ?? jane;
    const session = await world.newSession(principal);
    const first = await drain(
      await b.useCases.sendMessage.execute({
        principal,
        sessionId: session.id,
        text: 'go',
      }),
    );
    const pending = ((first[first.length - 1] as any).outcome.pending ??
      []) as any[];
    let events = first;
    for (const [i, call] of pending.entries()) {
      const decided = await b.useCases.decideApproval.execute({
        principal,
        sessionId: session.id,
        callId: call.callId,
        decision: options.decisions?.[i] ?? 'allow',
      });
      if (decided.run) events = await drain(decided.run);
    }
    const items = await world.items.read(session.id);
    const results = items.filter(
      (item): item is Item & { kind: 'tool_result' } =>
        item.kind === 'tool_result',
    );
    return { session, events, results };
  }

  const changes = (...names: string[]) =>
    names.map((name, i) => callTool(`m${i}`, 'demo:write', { name }));

  it('the change past the limit does not run, the run goes on, and the model hears why', async () => {
    world = await createWorld({ writesPerMinute: 2 });
    const b = backend([
      changes('a', 'b', 'c'),
      input => {
        const tools = input.messages.filter(m => m.role === 'tool');
        return [say(`heard ${tools.length}`)];
      },
    ]);
    const { results, events } = await run(b);
    expect(results.map(r => [r.status, r.message])).toEqual([
      ['ok', undefined],
      ['ok', undefined],
      ['error', QUOTA_MESSAGE(2)],
    ]);
    expect(world.actions.count('demo:write')).toBe(2);
    expect(events[events.length - 1]).toMatchObject({
      outcome: { status: 'completed' },
    });
    expect(b.model.inputs).toHaveLength(2);
    expect(JSON.stringify(b.model.inputs[1])).toContain(QUOTA_MESSAGE(2));
  });

  it('a change stopped by the quota does not stop the later changes of the step as a timeout does', async () => {
    world = await createWorld({ writesPerMinute: 1 });
    const b = backend([changes('a', 'b', 'c'), [say('done')]]);
    const { results } = await run(b);
    // Each later change asks the quota itself; none is refused for an
    // earlier change that may still run.
    expect(results.map(r => [r.status, r.message])).toEqual([
      ['ok', undefined],
      ['error', QUOTA_MESSAGE(1)],
      ['error', QUOTA_MESSAGE(1)],
    ]);
  });

  it('gives changes again in the next minute', async () => {
    world = await createWorld({ writesPerMinute: 1 });
    const b = backend([
      changes('a'),
      [say('one')],
      changes('b'),
      [say('two')],
      changes('c'),
      [say('three')],
    ]);
    expect((await run(b)).results[0].status).toBe('ok');
    expect((await run(b)).results[0].status).toBe('error');
    world.clock.advance(60);
    expect((await run(b)).results[0].status).toBe('ok');
    expect(world.actions.count('demo:write')).toBe(2);
  });

  it('counts the sessions of one user together, and another user on their own', async () => {
    world = await createWorld({ writesPerMinute: 1, runsPerUser: 5 });
    const b = backend([
      changes('a'),
      [say('one')],
      changes('b'),
      [say('two')],
      changes('c'),
      [say('three')],
    ]);
    expect((await run(b)).results[0].status).toBe('ok');
    expect((await run(b)).results[0].status).toBe('error');
    expect((await run(b, { principal: mallory })).results[0].status).toBe('ok');
  });

  it('counts only changes that run: a denied change and a read-only call take nothing', async () => {
    world = await createWorld({ writesPerMinute: 1 });
    const b = backend([
      [
        callTool('m0', 'demo:read', { name: 'r' }),
        callTool('m1', 'demo:write', { name: 'denied' }),
        callTool('m2', 'demo:write', { name: 'allowed' }),
      ],
      [say('done')],
    ]);
    const { results } = await run(b, { decisions: ['deny', 'allow'] });
    expect(results.map(r => r.status)).toEqual(['ok', 'denied', 'ok']);
    expect(world.actions.count('demo:write')).toBe(1);
  });

  it('two backends share the quota', async () => {
    world = await createWorld({ writesPerMinute: 1 });
    const a = backend([changes('a'), [say('one')]]);
    const b = backend([changes('b'), [say('two')]]);
    expect((await run(a)).results[0].status).toBe('ok');
    expect((await run(b)).results[0].status).toBe('error');
    expect(world.actions.count('demo:write')).toBe(1);
  });

  it('a change stopped by the quota has a failed audit record', async () => {
    world = await createWorld({ writesPerMinute: 1 });
    const b = backend([changes('a', 'b'), [say('done')]]);
    await run(b);
    const invokes = world.audit.events.filter(
      e => e.eventId === 'tool-call-invoke',
    );
    expect(invokes.map(e => e.outcome)).toEqual(['success', 'fail']);
  });

  it('without writesPerMinute, changes are not counted', async () => {
    world = await createWorld();
    const b = backend([changes('a', 'b', 'c'), [say('done')]]);
    const { results } = await run(b);
    expect(results.map(r => r.status)).toEqual(['ok', 'ok', 'ok']);
    const [{ n }] = await world.knex('write_quota_windows').count({ n: '*' });
    expect(Number(n)).toBe(0);
  });
});

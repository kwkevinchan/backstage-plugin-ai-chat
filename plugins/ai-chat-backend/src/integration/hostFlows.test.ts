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
  callTool,
  say,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import type { Item, ItemLog } from '@kwkevinchan/ai-chat-harness';
import { jane, mallory, createWorld, drain, until } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;

const kinds = (items: Item[]) => items.map(i => i.kind);
const writeCall = callTool('m1', 'demo:write', { name: 'x' });

describe('the host on a real database', () => {
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

  describe('CreateSession', () => {
    it('stores the default toolsets, and a list that was given', async () => {
      const a = backend([]);
      const made = await a.useCases.createSession.execute({ principal: jane });
      expect(made.enabledToolsets).toEqual(['demo']);
      const row = await world.knex('sessions').where({ id: made.id }).first();
      expect(JSON.parse(row.enabled_toolsets)).toEqual(['demo']);

      const none = await a.useCases.createSession.execute({
        principal: jane,
        enabledToolsets: [],
      });
      expect(none.enabledToolsets).toEqual([]);
    });

    it('refuses a toolset the administrator did not define (T-11)', async () => {
      const a = backend([]);
      await expect(
        a.useCases.createSession.execute({
          principal: jane,
          enabledToolsets: ['nope'],
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_TOOLSET' });
    });
  });

  describe('SendMessage', () => {
    it('runs the loop to the end and stores the answer (H-01)', async () => {
      const a = backend([[say('Hello')]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'Hi',
      });
      const events = await drain(handle);
      expect(events[0]).toMatchObject({ type: 'run.started' });
      expect(events[events.length - 1]).toMatchObject({
        type: 'run.ended',
        outcome: { status: 'completed' },
      });
      const items = await world.items.read(session.id);
      expect(kinds(items)).toEqual(['user_message', 'agent_message']);
      expect((await world.runRow(handle.runId)).status).toBe('completed');
      expect(a.supervisor.activeRunIds()).toEqual([]);
    });

    it('is refused for a user who is not the owner, and writes nothing', async () => {
      const a = backend([[say('Hello')]]);
      const session = await world.newSession();
      await expect(
        a.useCases.sendMessage.execute({
          principal: mallory,
          sessionId: session.id,
          text: 'Hi',
        }),
      ).rejects.toMatchObject({ code: 'NOT_SESSION_OWNER' });
      expect(await world.items.read(session.id)).toEqual([]);
      expect(await world.runCount()).toBe(0);
    });

    it('writes the message only after the run exists: a second message while a run is active leaves no message behind (H-03)', async () => {
      const a = backend([waitForAbort]);
      const session = await world.newSession();
      await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'first',
      });
      await expect(
        a.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'second',
        }),
      ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
      const items = await world.items.read(session.id);
      expect(items.map(i => (i as any).text)).toEqual(['first']);
    });

    it('ends the run when the loop cannot start, so the session is free', async () => {
      const a = backend([[say('x')]]);
      const session = await world.sessions.create({
        ownerRef: jane.userRef,
        agentId: 'gone',
        enabledToolsets: [],
      });
      await expect(
        a.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'Hi',
        }),
      ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
      expect(await world.runningRows()).toEqual([]);
      expect(await world.items.read(session.id)).toEqual([]);
    });

    it('takes no new run once the shutdown began (H-11)', async () => {
      const a = backend([[say('x')]]);
      const session = await world.newSession();
      await a.supervisor.shutdown(0);
      await expect(
        a.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'Hi',
        }),
      ).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
      expect(await world.runCount()).toBe(0);
    });
  });

  describe('a subscriber that leaves (H-07, A-06)', () => {
    it('does not stop the run, and the log is complete', async () => {
      const a = backend([[say('part one'), say(' part two')]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'Hi',
      });
      for await (const event of handle.events) {
        if (event.type === 'run.started') break;
      }
      await handle.done;
      const items = await world.items.read(session.id);
      expect(items.map(i => i.kind)).toEqual(['user_message', 'agent_message']);
      expect((items[1] as any).text).toBe('part one part two');
      expect((await world.runRow(handle.runId)).status).toBe('completed');
    });

    it('never reading the events does not stop the run either', async () => {
      const a = backend([[say('Hello')]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'Hi',
      });
      await handle.done;
      expect((await world.runRow(handle.runId)).status).toBe('completed');
    });
  });

  describe('DecideApproval', () => {
    async function waitingRun(a: ReturnType<typeof backend>, text = 'go') {
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text,
      });
      const events = await drain(handle);
      const ended = events[events.length - 1] as any;
      return { session, handle, pending: ended.outcome.pending as Item[] };
    }

    it('stops at a tool that is not read-only, and runs it once after the approval (H-01, D-05)', async () => {
      const a = backend([[writeCall], [say('done')]]);
      const { session, handle, pending } = await waitingRun(a);
      expect(pending).toHaveLength(1);
      expect((await world.runRow(handle.runId)).status).toBe(
        'waiting_approval',
      );
      expect(world.actions.count('demo:write')).toBe(0);

      const decided = await a.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId: (pending[0] as any).callId,
        decision: 'allow',
      });
      expect(decided.decision).toBe('allow');
      expect(decided.run).toBeDefined();
      const events = await drain(decided.run!);
      expect(events[events.length - 1]).toMatchObject({
        outcome: { status: 'completed' },
      });
      expect(world.actions.count('demo:write')).toBe(1);
      expect(world.actions.invocations[0].credentials).toBe(jane.credentials);
      expect((await world.runRow(handle.runId)).status).toBe('completed');
      expect(world.audit.ids()).toEqual([
        'tool-call-approve',
        'tool-call-invoke',
      ]);
      expect(world.audit.events.map(e => e.outcome)).toEqual([
        'success',
        'success',
      ]);
    });

    it('refuses a user who is not the owner, writes no decision and runs nothing', async () => {
      const a = backend([[writeCall], [say('done')]]);
      const { session, pending } = await waitingRun(a);
      await expect(
        a.useCases.decideApproval.execute({
          principal: mallory,
          sessionId: session.id,
          callId: (pending[0] as any).callId,
          decision: 'allow',
        }),
      ).rejects.toMatchObject({ code: 'NOT_SESSION_OWNER' });
      const items = await world.items.read(session.id);
      expect(kinds(items)).not.toContain('approval');
      expect(world.actions.count('demo:write')).toBe(0);
      expect(world.audit.events).toEqual([]);
    });

    it('records a denial, does not run the tool and the model hears about it (O-02)', async () => {
      const a = backend([
        [writeCall],
        (input: any) => {
          const tool = input.messages.find((m: any) => m.role === 'tool');
          return [say(`result: ${tool.content}`)];
        },
      ]);
      const { session, pending } = await waitingRun(a);
      const decided = await a.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId: (pending[0] as any).callId,
        decision: 'deny',
      });
      await drain(decided.run!);
      expect(world.actions.count('demo:write')).toBe(0);
      expect(world.audit.ids()).toEqual(['tool-call-deny']);
      const items = await world.items.read(session.id);
      expect(items.find(i => i.kind === 'tool_result')).toMatchObject({
        status: 'denied',
      });
    });

    it('does not audit a read-only tool', async () => {
      const a = backend([
        [callTool('m1', 'demo:read', { name: 'x' })],
        [say('done')],
      ]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'read',
      });
      await drain(handle);
      expect(world.actions.count('demo:read')).toBe(1);
      expect(world.audit.events).toEqual([]);
    });

    it('lets another backend decide: the tool runs once (P1-08)', async () => {
      const a = backend([[writeCall]]);
      const b = backend([[say('done by b')]]);
      const { session, pending } = await waitingRun(a);
      expect(a.supervisor.activeRunIds()).toEqual([]);

      const decided = await b.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId: (pending[0] as any).callId,
        decision: 'allow',
      });
      await drain(decided.run!);
      expect(world.actions.count('demo:write')).toBe(1);
      expect(b.model.inputs).toHaveLength(1);
      expect(a.model.inputs).toHaveLength(1);
      const items = await world.items.read(session.id);
      expect(items[items.length - 1]).toMatchObject({
        kind: 'agent_message',
        text: 'done by b',
      });
    });

    it('answers the same decision twice with the first one, and does not run the tool twice (T-07)', async () => {
      const a = backend([[writeCall], [say('done')]]);
      const { session, pending } = await waitingRun(a);
      const callId = (pending[0] as any).callId;
      const first = await a.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId,
        decision: 'allow',
      });
      await drain(first.run!);
      const again = await a.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId,
        decision: 'deny',
      });
      expect(again).toEqual({ decision: 'allow' });
      expect(world.actions.count('demo:write')).toBe(1);
      expect(world.audit.ids()).toEqual([
        'tool-call-approve',
        'tool-call-invoke',
      ]);
    });

    it('refuses a call that does not exist, and one that needs no decision', async () => {
      const a = backend([
        [callTool('m1', 'demo:read', { name: 'x' })],
        [say('done')],
      ]);
      const session = await world.newSession();
      await drain(
        await a.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'read',
        }),
      );
      await expect(
        a.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId: 'missing',
          decision: 'allow',
        }),
      ).rejects.toMatchObject({ code: 'TOOL_CALL_NOT_FOUND' });
      const call = (await world.items.read(session.id)).find(
        i => i.kind === 'tool_call',
      ) as any;
      await expect(
        a.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId: call.callId,
          decision: 'allow',
        }),
      ).rejects.toMatchObject({ code: 'TOOL_CALL_NOT_WAITING' });
    });

    describe('two calls in one step (P-04)', () => {
      const twoCalls = [
        callTool('m1', 'demo:write', { name: 'a' }),
        callTool('m2', 'demo:write2', { name: 'b' }),
      ];

      it('goes on only after both are decided, and starts the loop once when both decisions arrive at the same time', async () => {
        const a = backend([twoCalls]);
        const b = backend([[say('done')]]);
        const c = backend([[say('never')]]);
        const { session, pending } = await waitingRun(a);
        expect(pending).toHaveLength(2);

        const one = await b.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId: (pending[0] as any).callId,
          decision: 'allow',
        });
        expect(one.run).toBeUndefined();
        expect(world.actions.invocations).toHaveLength(0);

        const [x, y] = await Promise.all([
          b.useCases.decideApproval.execute({
            principal: jane,
            sessionId: session.id,
            callId: (pending[1] as any).callId,
            decision: 'allow',
          }),
          // The same decision again at the same moment, on another backend.
          c.useCases.decideApproval.execute({
            principal: jane,
            sessionId: session.id,
            callId: (pending[1] as any).callId,
            decision: 'allow',
          }),
        ]);
        const handles = [x.run, y.run].filter(Boolean);
        expect(handles).toHaveLength(1);
        await drain(handles[0]!);
        expect(world.actions.count('demo:write')).toBe(1);
        expect(world.actions.count('demo:write2')).toBe(1);
        expect(b.model.inputs.length + c.model.inputs.length).toBe(1);
      });
    });

    it('does not count the wait for an approval as working time', async () => {
      const a = backend([[writeCall], [say('done')]]);
      const { session, handle, pending } = await waitingRun(a);
      world.clock.advance(3600);
      const decided = await a.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId: (pending[0] as any).callId,
        decision: 'allow',
      });
      const events = await drain(decided.run!);
      expect(events[events.length - 1]).toMatchObject({
        outcome: { status: 'completed' },
      });
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('completed');
      expect(row.elapsed_seconds).toBeLessThan(5);
      expect(row.end_reason).toBeNull();
    });
  });

  describe('CancelRun (H-06)', () => {
    it('stops a run that this backend runs, and keeps the user message', async () => {
      const a = backend([waitForAbort]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => a.model.inputs.length === 1);
      await expect(
        a.useCases.cancelRun.execute({
          principal: mallory,
          sessionId: session.id,
          runId: handle.runId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_SESSION_OWNER' });
      expect(
        await a.useCases.cancelRun.execute({
          principal: jane,
          sessionId: session.id,
          runId: handle.runId,
        }),
      ).toBe(true);
      await handle.done;
      expect((await world.runRow(handle.runId)).status).toBe('cancelled');
      expect(kinds(await world.items.read(session.id))).toEqual([
        'user_message',
      ]);
    });

    it('stops a run that another backend runs: the lease timer sees the request', async () => {
      const a = backend([waitForAbort], { heartbeatMs: 20 });
      const b = backend([]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => a.model.inputs.length === 1);
      await b.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      await handle.done;
      expect((await world.runRow(handle.runId)).status).toBe('cancelled');
    });

    it('cancels a run that waits for an approval', async () => {
      const a = backend([[writeCall]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(handle);
      await a.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      expect((await world.runRow(handle.runId)).status).toBe('cancelled');
      expect(world.actions.count('demo:write')).toBe(0);
    });

    it('says false for a run that ended', async () => {
      const a = backend([[say('x')]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(handle);
      expect(
        await a.useCases.cancelRun.execute({
          principal: jane,
          sessionId: session.id,
          runId: handle.runId,
        }),
      ).toBe(false);
    });
  });

  describe('a lease that expires (H-04)', () => {
    it('is marked expired by ExpireStaleRuns, and the session takes a new run', async () => {
      const a = backend([waitForAbort]);
      const b = backend([[say('again')]]);
      const session = await world.newSession();
      const first = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'one',
      });
      await until(() => a.model.inputs.length === 1);

      expect(await b.useCases.expireStaleRuns.execute()).toEqual([]);
      world.clock.advance(31);
      expect(await b.useCases.expireStaleRuns.execute()).toEqual([first.runId]);
      expect((await world.runRow(first.runId)).status).toBe('expired');

      const second = await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'two',
      });
      await drain(second);
      expect((await world.runRow(second.runId)).status).toBe('completed');
      await a.supervisor.shutdown(0);
      // The old loop stopped without changing the run of someone else.
      expect((await world.runRow(first.runId)).status).toBe('expired');
    });
  });

  describe('shutdown (H-11)', () => {
    it('marks the run in progress expired, and leaves no running run', async () => {
      const a = backend([waitForAbort]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => a.model.inputs.length === 1);
      await a.supervisor.shutdown(30);
      await handle.done;
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('expired');
      expect(row.end_reason).toBe('shutdown');
      expect(row.active_session_id).toBeNull();
      expect(await world.runningRows()).toEqual([]);
      expect(a.supervisor.activeRunIds()).toEqual([]);
    });

    it('lets a run that is quick enough finish', async () => {
      const a = backend([[say('quick')]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await a.supervisor.shutdown(5000);
      expect((await world.runRow(handle.runId)).status).toBe('completed');
    });

    it('does not end a run that another backend took over', async () => {
      const a = backend([waitForAbort]);
      const b = backend([waitForAbort]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'long',
      });
      await until(() => a.model.inputs.length === 1);
      // The lease of a lapses and b takes the run.
      world.clock.advance(31);
      const taken = await b.runs.acquireLease(handle.runId);
      expect(taken).toBeDefined();

      await a.supervisor.shutdown(30);
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('running');
      expect(row.lease_owner).toBe(taken!.fence.leaseOwner);
    });
  });

  describe('an error of a port (the loop throws, there is no run.ended)', () => {
    it('ends the run as failed and tells the subscribers', async () => {
      const a = backend([[say('hi')]], {
        items: (inner: ItemLog): ItemLog => ({
          read: (...args) => inner.read(...args),
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
      const events = await drain(handle);
      expect(events[events.length - 1]).toMatchObject({
        type: 'run.ended',
        outcome: { status: 'failed', message: 'The run stopped.' },
      });
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('failed');
      expect(row.end_reason).toBe('error');
      expect(row.active_session_id).toBeNull();
      expect(a.logger.error).toHaveBeenCalled();
    });

    it('leaves the run alone when the lease is lost', async () => {
      const a = backend([waitForAbort]);
      const b = backend([[say('x')]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await until(() => a.model.inputs.length === 1);
      world.clock.advance(31);
      const taken = await b.runs.acquireLease(handle.runId);
      await a.supervisor.cancel(handle.runId);
      await handle.done;
      const row = await world.runRow(handle.runId);
      expect(row.status).toBe('running');
      expect(row.lease_owner).toBe(taken!.fence.leaseOwner);
    });
  });

  describe('sessions', () => {
    it('does not delete a session that has a run in progress', async () => {
      const a = backend([waitForAbort]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await expect(
        a.useCases.deleteSession.execute({
          principal: jane,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
      await a.supervisor.shutdown(0);
      await handle.done;
      await a.useCases.deleteSession.execute({
        principal: jane,
        sessionId: session.id,
      });
      await expect(world.sessions.get(session.id)).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });

    it('only the owner reads, lists, changes and deletes', async () => {
      const a = backend([]);
      const session = await world.newSession();
      for (const call of [
        () =>
          a.useCases.getSession.execute({
            principal: mallory,
            sessionId: session.id,
          }),
        () =>
          a.useCases.updateSession.execute({
            principal: mallory,
            sessionId: session.id,
            patch: { title: 'x' },
          }),
        () =>
          a.useCases.deleteSession.execute({
            principal: mallory,
            sessionId: session.id,
          }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: 'NOT_SESSION_OWNER',
        });
      }
      expect(
        await a.useCases.listSessions.execute({ principal: mallory }),
      ).toEqual([]);
      expect(
        (await a.useCases.listSessions.execute({ principal: jane })).map(
          s => s.id,
        ),
      ).toEqual([session.id]);
    });

    it('GetSession returns the items and the active run', async () => {
      const a = backend([[writeCall]]);
      const session = await world.newSession();
      const handle = await a.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await drain(handle);
      const view = await a.useCases.getSession.execute({
        principal: jane,
        sessionId: session.id,
      });
      expect(view.run).toMatchObject({
        id: handle.runId,
        status: 'waiting_approval',
      });
      expect(kinds(view.items)).toEqual(['user_message', 'tool_call']);
    });

    it('UpdateSession switches toolsets within the defined ones', async () => {
      const a = backend([]);
      const session = await world.newSession();
      const updated = await a.useCases.updateSession.execute({
        principal: jane,
        sessionId: session.id,
        patch: { enabledToolsets: [] },
      });
      expect(updated.enabledToolsets).toEqual([]);
      await expect(
        a.useCases.updateSession.execute({
          principal: jane,
          sessionId: session.id,
          patch: { enabledToolsets: ['other'] },
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_TOOLSET' });
    });
  });
});

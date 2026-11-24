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

import type { ItemLog } from '@kwkevinchan/ai-chat-harness';
import {
  callTool,
  say,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import { UiMessageStreamPresenter } from '../adapters/http/presenters/uiMessageStream';
import type { HostEvent } from '../application';
import type { Principal } from '../domain';
import {
  InsertLimitReached,
  NoActiveRun,
  QueueChanged,
  QueueFull,
  QueuedMessageNotFound,
  RunNotRunning,
} from '../domain';
import { createWorld, drain, jane, janeFresh, until } from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']>;

const writeCall = callTool('m1', 'demo:write', { name: 'x' });
const readCall = callTool('m1', 'demo:read', { name: 'x' });
const PAGE = {
  path: '/catalog/default/component/shop',
  entityRef: 'component:default/shop',
};

const countOf = (events: HostEvent[], type: string) =>
  events.filter(e => e.type === type).length;
const queueStateOf = (events: HostEvent[]) =>
  events.find(
    (e): e is Extract<HostEvent, { type: 'queue.state' }> =>
      e.type === 'queue.state',
  );

const userTexts = (input: { messages: { role: string; content: string }[] }) =>
  input.messages.filter(m => m.role === 'user').map(m => m.content);

/**
 * PI-03 on a real database (SQLite here, PostgreSQL in CI): inserted messages
 * and the end of a run, the queue and the automatic send. The two orders of a
 * race are made by hand with `aroundTransition`; the races of two connections
 * at the same time are in `postgresConcurrency.test.ts`.
 */
describe('inserted messages and the queue on a database', () => {
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

  const runRow = (runId: string) => world.runRow(runId);

  const insert = (
    host: Backend,
    sessionId: string,
    runId: string,
    text = 'change course',
  ) =>
    host.useCases.insertMessage.execute({
      principal: jane,
      sessionId,
      runId,
      text,
    });

  const queue = (
    host: Backend,
    sessionId: string,
    text: string,
    page?: typeof PAGE,
  ) =>
    host.useCases.queueMessage.execute({
      principal: jane,
      sessionId,
      text,
      ...(page && { page }),
    });

  const view = (host: Backend, sessionId: string) =>
    host.useCases.getSession.execute({ principal: jane, sessionId });

  async function send(
    host: Backend,
    sessionId: string,
    principal: Principal = janeFresh,
    text = 'go',
  ) {
    return host.useCases.sendMessage.execute({ principal, sessionId, text });
  }

  /** Starts a run that stops at a tool that needs an approval. */
  async function waitingRun(host: Backend, principal = janeFresh) {
    const session = await world.newSession();
    const handle = await send(host, session.id, principal);
    await drain(handle);
    const call = (await world.items.read(session.id)).find(
      item => item.kind === 'tool_call',
    ) as { callId: string };
    return { session, handle, callId: call.callId };
  }

  /** Starts a run whose model call does not end until the run is stopped. */
  async function blockedRun(host: Backend, principal = janeFresh) {
    const session = await world.newSession();
    const handle = await send(host, session.id, principal);
    await until(() => host.model.inputs.length > 0);
    return { session, handle };
  }

  const allow = (
    host: Backend,
    sessionId: string,
    callId: string,
    principal = janeFresh,
  ) =>
    host.useCases.decideApproval.execute({
      principal,
      sessionId,
      callId,
      decision: 'allow',
    });

  describe('an insert and the end of the run (IN-11)', () => {
    it('insert first: the status change is refused, the run stays running, the loop reads the message and then completes; the subscriber sees one run.started and one run.ended', async () => {
      const session = await world.newSession();
      let done = false;
      let statusAfterInsert: string | undefined;
      const a: Backend = backend(
        [[say('first answer')], [say('second answer')]],
        {
          aroundTransition: async (info, call) => {
            if (info.to === 'completed' && !done) {
              done = true;
              // After the loop decided to complete, before the status change.
              await insert(a, session.id, info.runId, 'use staging');
              statusAfterInsert = (await runRow(info.runId)).status;
            }
            return call();
          },
        },
      );
      const handle = await send(a, session.id, jane, 'deploy');
      const events = await drain(handle);

      expect(statusAfterInsert).toBe('running');
      expect(a.model.inputs).toHaveLength(2);
      expect(userTexts(a.model.inputs[0])).toEqual(['deploy']);
      expect(userTexts(a.model.inputs[1])).toEqual(['deploy', 'use staging']);
      expect((await runRow(handle.runId)).status).toBe('completed');
      expect(countOf(events, 'run.started')).toBe(1);
      expect(countOf(events, 'run.ended')).toBe(1);
      expect(countOf(events, 'message.read')).toBe(1);
      const kinds = (await world.items.read(session.id)).map(item =>
        item.kind === 'user_message'
          ? `user_message:${item.delivery ?? 'direct'}`
          : item.kind,
      );
      expect(kinds).toEqual([
        'user_message:direct',
        'agent_message',
        'user_message:inserted',
        'agent_message',
      ]);
      // The model read it, so the screen shows it as read.
      const inserted = (await world.items.read(session.id))[2];
      expect((await view(a, session.id)).insertStates.get(inserted.seq)).toBe(
        'read',
      );
    });

    it('end first: the insert gets RunNotRunning, and the log has no such message', async () => {
      const session = await world.newSession();
      let outcome: unknown;
      const a: Backend = backend([[say('answer')]], {
        aroundTransition: async (info, call) => {
          const run = await call();
          if (info.to === 'completed') {
            outcome = await insert(a, session.id, info.runId).catch(e => e);
          }
          return run;
        },
      });
      const handle = await send(a, session.id, jane, 'deploy');
      await drain(handle);
      expect(outcome).toBeInstanceOf(RunNotRunning);
      expect(
        (await world.items.read(session.id)).filter(
          i => i.kind === 'user_message' && i.delivery === 'inserted',
        ),
      ).toEqual([]);
    });

    it('a message that comes in during a model call is read by the next call, and the stream sends it as data-inserted although its seq is lower than the output before it', async () => {
      const session = await world.newSession();
      let done = false;
      // Written between the read of the log and the write of the output.
      const a: Backend = backend([[say('answer 1')], [say('answer 2')]], {
        items: (inner: ItemLog) => ({
          read: (...args) => inner.read(...args),
          append: async (sessionId, drafts, fence) => {
            if (!done && drafts.some(d => d.kind === 'agent_message')) {
              done = true;
              await insert(a, sessionId, fence.runId, 'wait, staging');
            }
            return inner.append(sessionId, drafts, fence);
          },
        }),
      });
      const handle = await send(a, session.id, jane, 'deploy');
      const events = await drain(handle);

      expect(a.model.inputs).toHaveLength(2);
      expect(userTexts(a.model.inputs[1])).toEqual(['deploy', 'wait, staging']);
      const log = await world.items.read(session.id);
      const first = log.find(i => i.kind === 'agent_message')!;
      const message = log.find(
        i => i.kind === 'user_message' && i.delivery === 'inserted',
      )!;
      // The first answer did not read it: its seq is above the mark.
      expect((first as { readUpToSeq: number }).readUpToSeq).toBeLessThan(
        message.seq,
      );
      expect(message.seq).toBeLessThan(first.seq);

      const presenter = new UiMessageStreamPresenter({ runId: handle.runId });
      const chunks = events.flatMap(event => presenter.present(event));
      const inserted = chunks.filter(c => c.type === 'data-inserted');
      expect(inserted).toEqual([
        {
          type: 'data-inserted',
          id: `inserted-${message.seq}`,
          data: { seq: message.seq, text: 'wait, staging' },
        },
      ]);
      const types = chunks.map(c => c.type);
      const steps = types.reduce<number[]>(
        (at, type, i) => (type === 'start-step' ? [...at, i] : at),
        [],
      );
      expect(steps).toHaveLength(2);
      expect(types.indexOf('data-inserted')).toBeGreaterThan(steps[0]);
      expect(types.indexOf('data-inserted')).toBeLessThan(steps[1]);
    });

    it('refuses the insert while the run waits for an approval, and writes nothing (RunNotRunning)', async () => {
      const a = backend([[writeCall]]);
      const { session, handle } = await waitingRun(a);
      const before = await world.items.read(session.id);
      await expect(insert(a, session.id, handle.runId)).rejects.toBeInstanceOf(
        RunNotRunning,
      );
      expect(await world.items.read(session.id)).toEqual(before);
    });

    it.each(['completed', 'cancelled'] as const)(
      'refuses the insert when the run has %s, and writes nothing (RunNotRunning)',
      async ending => {
        const a = backend([
          ending === 'completed' ? [say('done')] : waitForAbort,
        ]);
        const session = await world.newSession();
        const handle = await send(a, session.id);
        if (ending === 'cancelled') {
          await until(() => a.model.inputs.length === 1);
          await a.useCases.cancelRun.execute({
            principal: jane,
            sessionId: session.id,
            runId: handle.runId,
          });
        }
        await drain(handle);
        expect((await runRow(handle.runId)).status).toBe(ending);
        const before = await world.items.read(session.id);
        await expect(
          insert(a, session.id, handle.runId),
        ).rejects.toBeInstanceOf(RunNotRunning);
        expect(await world.items.read(session.id)).toEqual(before);
      },
    );

    it('refuses the insert when the lease expired, though the run is not marked expired yet', async () => {
      const a = backend([waitForAbort]);
      const { session, handle } = await blockedRun(a);
      world.clock.advance(31);
      await expect(insert(a, session.id, handle.runId)).rejects.toBeInstanceOf(
        RunNotRunning,
      );
      expect(await world.items.read(session.id)).toHaveLength(1);
    });

    it('refuses the insert for a run that is not this one: an id that does not exist, and the run of another session', async () => {
      const a = backend([waitForAbort, waitForAbort]);
      const one = await blockedRun(a);
      const two = await send(a, (await world.newSession()).id);
      await until(() => a.model.inputs.length === 2);
      await expect(
        insert(a, one.session.id, 'no-such-run'),
      ).rejects.toBeInstanceOf(RunNotRunning);
      await expect(insert(a, one.session.id, two.runId)).rejects.toBeInstanceOf(
        RunNotRunning,
      );
      expect(await world.items.read(one.session.id)).toHaveLength(1);
    });

    it('takes five inserted messages and refuses the sixth (InsertLimitReached)', async () => {
      const a = backend([waitForAbort]);
      const { session, handle } = await blockedRun(a);
      for (let i = 1; i <= 5; i++) {
        await insert(a, session.id, handle.runId, `m${i}`);
      }
      await expect(
        insert(a, session.id, handle.runId, 'm6'),
      ).rejects.toBeInstanceOf(InsertLimitReached);
      expect(await world.items.read(session.id)).toHaveLength(6);
    });

    it('an insert written before the run turned waiting_approval is read by the model after the approval, after the tool result', async () => {
      const session = await world.newSession();
      const a: Backend = backend([[writeCall], [say('done')]], {
        aroundTransition: async (info, call) => {
          if (info.to === 'waiting_approval') {
            await insert(a, session.id, info.runId, 'only to staging');
          }
          return call();
        },
      });
      const handle = await send(a, session.id, janeFresh, 'deploy');
      await drain(handle);
      expect((await runRow(handle.runId)).status).toBe('waiting_approval');
      const call = (await world.items.read(session.id)).find(
        i => i.kind === 'tool_call',
      ) as { callId: string };

      const decided = await allow(a, session.id, call.callId);
      await drain(decided.run!);

      expect((await runRow(handle.runId)).status).toBe('completed');
      const second = a.model.inputs[1];
      expect(second.messages.map(m => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
      ]);
      expect(userTexts(second)).toEqual(['deploy', 'only to staging']);
    });
  });

  describe('a run that ends without reading an inserted message (IN-12)', () => {
    it('Stop: the message is pending while the run goes on and unread after, and the queue is paused', async () => {
      const a = backend([waitForAbort]);
      const { session, handle } = await blockedRun(a);
      const item = await insert(a, session.id, handle.runId);
      await queue(a, session.id, 'then this');
      const during = await view(a, session.id);
      expect(during.insertStates.get(item.seq)).toBe('pending');
      expect(during.queue.paused).toBe(false);

      await a.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      await handle.done;

      const after = await view(a, session.id);
      expect(after.insertStates.get(item.seq)).toBe('unread');
      expect(after.queue.paused).toBe(true);
      expect(after.queue.items.map(m => m.text)).toEqual(['then this']);
    });

    it('lease expiry: the message is unread and the queue is paused', async () => {
      const a = backend([waitForAbort]);
      const { session, handle } = await blockedRun(a);
      const item = await insert(a, session.id, handle.runId);
      await queue(a, session.id, 'then this');
      world.clock.advance(31);
      expect(await a.useCases.expireStaleRuns.execute()).toEqual([
        handle.runId,
      ]);
      const after = await view(a, session.id);
      expect(after.insertStates.get(item.seq)).toBe('unread');
      expect(after.queue.paused).toBe(true);
    });

    it('a limit ends the run without reading the message: it stays unread and the model is not called again for it', async () => {
      await world.cleanup();
      world = await createWorld({ limits: { maxSteps: 1 } });
      const session = await world.newSession();
      let done = false;
      const a: Backend = backend([[readCall], [say('never called')]], {
        items: (inner: ItemLog) => ({
          read: (...args) => inner.read(...args),
          append: async (sessionId, drafts, fence) => {
            if (!done && drafts.some(d => d.kind === 'tool_call')) {
              done = true;
              await insert(a, sessionId, fence.runId, 'late idea');
            }
            return inner.append(sessionId, drafts, fence);
          },
        }),
      });
      const handle = await send(a, session.id);
      await drain(handle);

      const row = await runRow(handle.runId);
      expect(row).toMatchObject({
        status: 'completed',
        end_reason: 'max_steps',
      });
      expect(a.model.inputs).toHaveLength(1);
      const message = (await world.items.read(session.id)).find(
        i => i.kind === 'user_message' && i.delivery === 'inserted',
      )!;
      expect((await view(a, session.id)).insertStates.get(message.seq)).toBe(
        'unread',
      );
    });
  });

  describe('the queue (IN-13, IN-15)', () => {
    it('refuses a message when no run goes on (NoActiveRun), and a sixth message (QueueFull)', async () => {
      const a = backend([waitForAbort]);
      const idle = await world.newSession();
      await expect(queue(a, idle.id, 'x')).rejects.toBeInstanceOf(NoActiveRun);

      const { session } = await blockedRun(a);
      for (let i = 1; i <= 5; i++) await queue(a, session.id, `m${i}`);
      await expect(queue(a, session.id, 'm6')).rejects.toBeInstanceOf(
        QueueFull,
      );
      expect((await view(a, session.id)).queue.items).toHaveLength(5);
    });

    it('accepts a message while the run waits for an approval, and sends nothing then', async () => {
      const a = backend([[writeCall]]);
      const { session, handle } = await waitingRun(a);
      await queue(a, session.id, 'next');
      const after = await view(a, session.id);
      // The run has not ended: the queue is not paused and nothing was sent.
      expect(after.queue).toMatchObject({ paused: false });
      expect(after.queue.items).toHaveLength(1);
      expect(await world.runCount()).toBe(1);
      expect((await runRow(handle.runId)).status).toBe('waiting_approval');
    });

    it('add first, then the end: the message is in the queue when the run ends, and it is sent', async () => {
      const session = await world.newSession();
      let added = false;
      const a: Backend = backend([[say('one')], [say('two')]], {
        aroundTransition: async (info, call) => {
          if (info.to === 'completed' && !added) {
            added = true;
            await queue(a, session.id, 'next one');
          }
          return call();
        },
      });
      const handle = await send(a, session.id);
      const events = await drain(handle);
      const next = queueStateOf(events)!.nextRunId!;
      await until(async () => (await runRow(next)).status === 'completed');
      expect(await world.runCount()).toBe(2);
      expect((await view(a, session.id)).queue.items).toEqual([]);
    });

    it('the end first, then the add: NoActiveRun, and nothing is left in the queue', async () => {
      const session = await world.newSession();
      let outcome: unknown;
      const a: Backend = backend([[say('one')]], {
        aroundTransition: async (info, call) => {
          const run = await call();
          if (info.to === 'completed') {
            outcome = await queue(a, session.id, 'late').catch(e => e);
          }
          return run;
        },
      });
      const handle = await send(a, session.id);
      await drain(handle);
      expect(outcome).toBeInstanceOf(NoActiveRun);
      expect((await view(a, session.id)).queue.items).toEqual([]);
    });

    it('two tabs: A deletes one, B reorders with its old list and gets QueueChanged, B changing the deleted one gets QueuedMessageNotFound, and the positions are 1, 2 after a reorder', async () => {
      const a = backend([waitForAbort]);
      const { session } = await blockedRun(a);
      const m1 = await queue(a, session.id, 'one');
      const m2 = await queue(a, session.id, 'two');
      const m3 = await queue(a, session.id, 'three');
      await a.useCases.deleteQueuedMessage.execute({
        principal: jane,
        sessionId: session.id,
        queuedId: m2.id,
      });
      await expect(
        a.useCases.reorderQueue.execute({
          principal: jane,
          sessionId: session.id,
          ids: [m3.id, m2.id, m1.id],
        }),
      ).rejects.toBeInstanceOf(QueueChanged);
      await expect(
        a.useCases.updateQueuedMessage.execute({
          principal: jane,
          sessionId: session.id,
          queuedId: m2.id,
          patch: { text: 'changed' },
        }),
      ).rejects.toBeInstanceOf(QueuedMessageNotFound);
      const reordered = await a.useCases.reorderQueue.execute({
        principal: jane,
        sessionId: session.id,
        ids: [m3.id, m1.id],
      });
      expect(reordered.items.map(m => [m.position, m.text])).toEqual([
        [1, 'three'],
        [2, 'one'],
      ]);
    });
  });

  describe('the automatic send (IN-14, IN-16, IN-17)', () => {
    /** The run waits for an approval; the user queues a message; the run is allowed and ends well. */
    async function queuedAfterApproval(
      host: Backend,
      principal: Principal,
      page = PAGE,
    ) {
      const { session, callId } = await waitingRun(host);
      await queue(host, session.id, 'and the next one', page);
      await queue(host, session.id, 'and one more');
      const decided = await allow(host, session.id, callId, principal);
      const events = await drain(decided.run!);
      return { session, events, runId: decided.run!.runId };
    }

    it('starts a run with the first queued message: delivery queued, the page it was queued with, one row less; the stream says which run follows; the audit log has the event', async () => {
      const a = backend([
        [writeCall],
        [say('done')],
        [say('the next answer')],
        [say('the last answer')],
      ]);
      const { session, events, runId } = await queuedAfterApproval(
        a,
        janeFresh,
      );

      const state = queueStateOf(events)!;
      // One row less: the first message left the queue.
      expect(state).toMatchObject({ paused: false });
      expect(state.items.map(m => m.text)).toEqual(['and one more']);
      expect(state.nextRunId).toEqual(expect.any(String));
      // The state of the queue goes out before the end of the run.
      expect(events.findIndex(e => e.type === 'queue.state')).toBeLessThan(
        events.findIndex(e => e.type === 'run.ended'),
      );
      const next = state.nextRunId!;
      await until(async () => (await runRow(next)).status === 'completed');
      await until(async () => (await world.runningRows()).length === 0);

      const log = await world.items.read(session.id);
      const queued = log.find(
        i => i.kind === 'user_message' && i.delivery === 'queued',
      )!;
      expect(queued).toMatchObject({
        text: 'and the next one',
        page: PAGE,
        runId: next,
      });
      expect(a.model.inputs[2].messages.map(m => m.role)).toContain('user');
      expect(JSON.stringify(a.model.inputs[2])).toContain(PAGE.path);
      expect((await runRow(runId)).status).toBe('completed');
      // One event for each message that was sent; the second run ended well
      // too, so the second message went out as well.
      const sent = world.audit.events.filter(
        e => e.eventId === 'queued-message-send',
      );
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({
        eventId: 'queued-message-send',
        actorRef: 'user:default/jane',
        sessionId: session.id,
        runId: next,
        queuedMessageId: expect.any(String),
        outcome: 'success',
      });
    });

    it('sends the messages one after the other, each when the run before it ended', async () => {
      const a = backend([
        [writeCall],
        [say('done')],
        [say('answer 2')],
        [say('answer 3')],
      ]);
      const { session, events } = await queuedAfterApproval(a, janeFresh);
      expect(queueStateOf(events)!.nextRunId).toBeDefined();
      await until(async () => (await world.runCount()) === 3);
      await until(async () => (await world.runningRows()).length === 0);
      expect((await view(a, session.id)).queue.items).toEqual([]);
      const texts = (await world.items.read(session.id))
        .filter(i => i.kind === 'user_message')
        .map(i => (i as { text: string }).text);
      expect(texts).toEqual(['go', 'and the next one', 'and one more']);
    });

    it('does not send when the credentials have too little time left, or no known end, and says so (IN-16)', async () => {
      for (const expires of [undefined, '2026-01-01T00:05:29.000Z']) {
        const a = backend([[writeCall], [say('done')]]);
        const principal: Principal = {
          ...jane,
          ...(expires && { credentialsExpireAt: expires }),
        };
        const { session, events } = await queuedAfterApproval(a, principal);
        expect(queueStateOf(events)).toMatchObject({
          paused: true,
          pausedReason: 'credentials',
        });
        expect(queueStateOf(events)!.nextRunId).toBeUndefined();
        expect((await view(a, session.id)).queue).toMatchObject({
          paused: true,
        });
      }
      expect(await world.runCount()).toBe(2);
    });

    it('uses the identity of the run that ended: the tools of the next run get its credentials', async () => {
      const a = backend([
        [writeCall],
        [say('done')],
        [readCall],
        [say('ok')],
        [say('and the last one')],
      ]);
      const other: Principal = {
        ...janeFresh,
        credentials: { marker: 'identity of the last request' },
      };
      const { events } = await queuedAfterApproval(a, other);
      const next = queueStateOf(events)!.nextRunId!;
      await until(async () => (await runRow(next)).status === 'completed');
      const read = world.actions.invocations.find(i => i.id === 'demo:read')!;
      expect(read.credentials).toBe(other.credentials);
    });

    it('does not send after a run that failed, was cancelled, expired or stopped by a limit: the queue is paused and the messages stay (D-30)', async () => {
      // Failed: the model call throws.
      const failedSession = await world.newSession();
      const failing: Backend = backend([new Error('model down')], {
        aroundTransition: async (info, call) => {
          if (info.to === 'failed') await queue(failing, failedSession.id, 'q');
          return call();
        },
      });
      const failed = await drain(await send(failing, failedSession.id));
      expect(queueStateOf(failed)).toMatchObject({
        paused: true,
        pausedReason: 'run_not_completed',
      });
      expect((await view(failing, failedSession.id)).queue).toMatchObject({
        paused: true,
      });

      // Cancelled by the user.
      const stopping = backend([waitForAbort]);
      const stopped = await blockedRun(stopping);
      await queue(stopping, stopped.session.id, 'q');
      await stopping.useCases.cancelRun.execute({
        principal: jane,
        sessionId: stopped.session.id,
        runId: stopped.handle.runId,
      });
      const cancelled = await drain(stopped.handle);
      expect(queueStateOf(cancelled)).toMatchObject({
        paused: true,
        pausedReason: 'run_not_completed',
      });

      // Expired: the lease ran out.
      const expiring = backend([waitForAbort]);
      const lapsed = await blockedRun(expiring);
      await queue(expiring, lapsed.session.id, 'q');
      world.clock.advance(31);
      await expiring.useCases.expireStaleRuns.execute();
      expect((await view(expiring, lapsed.session.id)).queue).toMatchObject({
        paused: true,
      });

      // Every run stayed alone: nothing was started for the queues.
      expect(await world.runCount()).toBe(3);
    });

    it('does not send after a run that a limit stopped (completed with an end reason)', async () => {
      await world.cleanup();
      world = await createWorld({ limits: { maxSteps: 1 } });
      const session = await world.newSession();
      let queued = false;
      const a: Backend = backend([[readCall], [say('never')]], {
        aroundTransition: async (info, call) => {
          if (info.to === 'completed' && !queued) {
            queued = true;
            await queue(a, session.id, 'q');
          }
          return call();
        },
      });
      const events = await drain(await send(a, session.id));
      expect(queueStateOf(events)).toMatchObject({
        paused: true,
        pausedReason: 'run_not_completed',
      });
      expect(await world.runCount()).toBe(1);
      expect((await view(a, session.id)).queue.items).toHaveLength(1);
    });

    it('sends nothing and does not pause the queue when the run turns to waiting for an approval with messages in it; it sends when the run ends well afterwards', async () => {
      const session = await world.newSession();
      let queued = false;
      const a: Backend = backend(
        [[writeCall], [say('done')], [say('next answer')]],
        {
          aroundTransition: async (info, call) => {
            if (info.to === 'waiting_approval' && !queued) {
              queued = true;
              await queue(a, session.id, 'after the approval');
            }
            return call();
          },
        },
      );
      const first = await drain(await send(a, session.id));
      // The run has not ended: the queue is not paused, and nothing started.
      expect(queueStateOf(first)).toMatchObject({ paused: false });
      expect(queueStateOf(first)!.items).toHaveLength(1);
      expect(queueStateOf(first)!.nextRunId).toBeUndefined();
      expect(await world.runCount()).toBe(1);

      const call = (await world.items.read(session.id)).find(
        i => i.kind === 'tool_call',
      ) as { callId: string };
      const decided = await allow(a, session.id, call.callId);
      const events = await drain(decided.run!);
      expect(queueStateOf(events)!.nextRunId).toEqual(expect.any(String));
    });
  });

  describe('Continue (IN-15)', () => {
    async function pausedQueue(host: Backend) {
      const session = await world.newSession();
      const failing = await send(host, session.id);
      await until(() => host.model.inputs.length === 1);
      await queue(host, session.id, 'first');
      await queue(host, session.id, 'second');
      await host.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: failing.runId,
      });
      await drain(failing);
      return session;
    }

    it('starts a run with the first message for the identity of the request, whatever time its credentials have left', async () => {
      const a = backend([waitForAbort, [say('first answer')]]);
      const session = await pausedQueue(a);
      expect((await view(a, session.id)).queue.paused).toBe(true);

      const handle = await a.useCases.resumeQueue.execute({
        principal: jane,
        sessionId: session.id,
      });
      expect(handle).toBeDefined();
      await drain(handle!);
      expect((await runRow(handle!.runId)).status).toBe('completed');
      const log = await world.items.read(session.id);
      expect(
        log
          .filter(i => i.kind === 'user_message')
          .map(i => (i as any).delivery),
      ).toEqual([undefined, 'queued']);
      expect((await view(a, session.id)).queue.items.map(m => m.text)).toEqual([
        'second',
      ]);
    });

    it('does nothing when the queue is empty, or a run goes on', async () => {
      const a = backend([waitForAbort]);
      const empty = await world.newSession();
      expect(
        await a.useCases.resumeQueue.execute({
          principal: jane,
          sessionId: empty.id,
        }),
      ).toBeUndefined();

      const { session } = await blockedRun(a);
      await queue(a, session.id, 'x');
      expect(
        await a.useCases.resumeQueue.execute({
          principal: jane,
          sessionId: session.id,
        }),
      ).toBeUndefined();
      expect((await view(a, session.id)).queue.items).toHaveLength(1);
    });

    it('starts one run and sends one message when two backends are asked at the same time', async () => {
      const a = backend([waitForAbort, [say('answer')]]);
      const b = backend([[say('answer')]]);
      const session = await pausedQueue(a);
      const results = await Promise.all(
        [a, b].map(host =>
          host.useCases.resumeQueue.execute({
            principal: jane,
            sessionId: session.id,
          }),
        ),
      );
      const handles = results.filter(Boolean);
      expect(handles).toHaveLength(1);
      await drain(handles[0]!);
      const queued = (await world.items.read(session.id)).filter(
        i => i.kind === 'user_message' && i.delivery === 'queued',
      );
      expect(queued).toHaveLength(1);
    });
  });
});

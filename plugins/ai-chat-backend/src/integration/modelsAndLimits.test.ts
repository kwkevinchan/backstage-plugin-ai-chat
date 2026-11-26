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
  ModelClient,
  ModelImageData,
  ModelInput,
  ModelStreamOptions,
} from '@kwkevinchan/ai-chat-harness';
import { callTool, say } from '@kwkevinchan/ai-chat-harness/testing';
import { KnexModelCallLimiter } from '../adapters/persistence';
import { TITLE_PROMPT_MARK } from '../application';
import { RunAlreadyActive, TooManyActiveRuns } from '../domain';
import { IMAGES } from '../__testUtils__/images';
import {
  createWorld,
  drain,
  jane,
  janeFresh,
  mallory,
  until,
} from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;
type Backend = ReturnType<World['backend']>;

const writeCall = callTool('m1', 'demo:write', { name: 'x' });

/** A model client that answers with a fixed text and keeps what it got. */
function recordingModel(answer: string) {
  const calls: { input: ModelInput; opts: ModelStreamOptions }[] = [];
  const client: ModelClient = {
    capabilities: { parallelToolCalls: false, images: true },
    async *stream(input, opts) {
      calls.push({ input, opts });
      yield {
        type: 'text',
        text: input.system.startsWith(TITLE_PROMPT_MARK) ? 'A title' : answer,
      };
    },
  };
  return { client, calls };
}

describe('models, limits per step and per user, and rate limits (P3-07)', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<World['backend']>): Backend {
    const b = world.backend(...args);
    open.push(b.supervisor);
    return b;
  }

  /** A run that stops at a tool that needs an approval: it stays active. */
  async function waitingRun(host: Backend, principal = jane) {
    const session = await world.newSession(principal);
    const handle = await host.useCases.sendMessage.execute({
      principal,
      sessionId: session.id,
      text: 'go',
    });
    await drain(handle);
    expect((await world.runRow(handle.runId)).status).toBe('waiting_approval');
    return { session, handle };
  }

  describe('the model of an agent (X-09)', () => {
    it('calls the client of the model the agent names, for its steps and its title, and default for the others', async () => {
      world = await createWorld({
        agents: { sre: { systemPrompt: 'You help.', model: 'small' } },
      });
      const small = recordingModel('from small');
      const host = backend([[say('from default')]], {
        models: new Map([['small', small.client]]),
      });

      const sre = await world.newSession(janeFresh, 'sre');
      await drain(
        await host.useCases.sendMessage.execute({
          principal: janeFresh,
          sessionId: sre.id,
          text: 'hi',
        }),
      );
      await until(
        async () => (await world.sessions.get(sre.id)).title !== undefined,
      );

      expect(host.model.inputs).toHaveLength(0);
      expect(
        small.calls.map(c => c.input.system.startsWith(TITLE_PROMPT_MARK)),
      ).toEqual([false, true]);
      const answer = (await world.items.read(sre.id)).find(
        item => item.kind === 'agent_message',
      );
      expect(answer).toMatchObject({ text: 'from small' });

      const other = await world.newSession(janeFresh);
      await drain(
        await host.useCases.sendMessage.execute({
          principal: janeFresh,
          sessionId: other.id,
          text: 'hi',
        }),
      );
      expect(host.model.inputs).toHaveLength(1);
      expect(small.calls).toHaveLength(2);
    });

    it('gives the client readImage, which reads the bytes of an image of the session and undefined for one that is gone', async () => {
      world = await createWorld({
        agents: { viewer: { systemPrompt: 'You look.', model: 'module' } },
      });
      const read: (ModelImageData | undefined)[] = [];
      const client: ModelClient = {
        capabilities: { parallelToolCalls: false, images: true },
        async *stream(input, opts) {
          const [message] = input.messages;
          for (const image of message.role === 'user'
            ? message.images ?? []
            : []) {
            read.push(await opts.readImage!(image));
          }
          yield { type: 'text', text: 'seen' };
        },
      };
      const host = backend([], { models: new Map([['module', client]]) });
      const session = await world.newSession(jane, 'viewer');
      const kept = await world.attachments.put({
        sessionId: session.id,
        ownerRef: jane.userRef,
        mediaType: 'image/png',
        name: 'kept.png',
        bytes: IMAGES['image/png'],
        maxPending: 100,
      });
      const gone = await world.attachments.put({
        sessionId: session.id,
        ownerRef: jane.userRef,
        mediaType: 'image/png',
        name: 'gone.png',
        bytes: IMAGES['image/png'],
        maxPending: 100,
      });
      const handle = await host.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'look',
        attachmentIds: [kept.id, gone.id],
      });
      // An image deleted after the message was sent, as a row changed by hand.
      await world.knex('attachments').where({ id: gone.id }).delete();
      await drain(handle);

      expect(read).toHaveLength(2);
      expect(read[0]?.mediaType).toBe('image/png');
      expect(Buffer.from(read[0]!.bytes).equals(IMAGES['image/png'])).toBe(
        true,
      );
      expect(read[1]).toBeUndefined();
    });
  });

  describe('read-only calls at the same time through the host (P-01, P-03)', () => {
    it('runs four actions at once, cuts each output to maxToolOutputChars, and stores and streams the results in order', async () => {
      world = await createWorld();
      let running = 0;
      let most = 0;
      world.actions.invoke = async options => {
        running += 1;
        most = Math.max(most, running);
        const n = Number((options.input as { n: string }).n);
        await new Promise(resolve => setTimeout(resolve, (5 - n) * 10));
        running -= 1;
        return { output: { n, text: 'x'.repeat(30000) } };
      };
      const host = backend([
        [1, 2, 3, 4].map(n => callTool(`m${n}`, 'demo:read', { n: String(n) })),
        [say('done')],
      ]);
      const session = await world.newSession();

      const events = await drain(
        await host.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'go',
        }),
      );

      expect(most).toBe(4);
      const log = await world.items.read(session.id);
      const calls = log.flatMap(item =>
        item.kind === 'tool_call' ? [item] : [],
      );
      const results = log.flatMap(item =>
        item.kind === 'tool_result' ? [item] : [],
      );
      expect(results.map(r => r.callId)).toEqual(calls.map(c => c.callId));
      expect(
        results.every(r => r.status === 'ok' && r.truncated === true),
      ).toBe(true);
      expect(results.every(r => JSON.stringify(r.output).length <= 20000)).toBe(
        true,
      );
      const streamed = events.flatMap(event =>
        event.type === 'item.completed' && event.item.kind === 'tool_result'
          ? [event.item]
          : [],
      );
      expect(streamed).toEqual(results);
    });
  });

  describe('runs per user (P-05)', () => {
    it('refuses a run beyond runsPerUser with TooManyActiveRuns and writes nothing; other users and an ended run free it', async () => {
      world = await createWorld({ runsPerUser: 2 });
      const host = backend([
        [writeCall],
        [writeCall],
        [writeCall],
        [writeCall],
      ]);
      const first = await waitingRun(host);
      await waitingRun(host);
      const third = await world.newSession();
      const runsBefore = await world.runCount();

      await expect(
        host.useCases.sendMessage.execute({
          principal: jane,
          sessionId: third.id,
          text: 'one more',
        }),
      ).rejects.toBeInstanceOf(TooManyActiveRuns);
      expect(await world.runCount()).toBe(runsBefore);
      expect(await world.items.read(third.id)).toEqual([]);

      // Another user has runs of their own.
      await waitingRun(host, mallory);

      await host.useCases.cancelRun.execute({
        principal: jane,
        sessionId: first.session.id,
        runId: first.handle.runId,
      });
      await drain(
        await host.useCases.sendMessage.execute({
          principal: jane,
          sessionId: third.id,
          text: 'now',
        }),
      );
      expect((await world.items.read(third.id))[0]).toMatchObject({
        text: 'now',
      });
    });

    it('answers RunAlreadyActive, not the limit, for a session that has a run', async () => {
      world = await createWorld({ runsPerUser: 1 });
      const host = backend([[writeCall]]);
      const { session } = await waitingRun(host);
      await expect(
        host.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'again',
        }),
      ).rejects.toBeInstanceOf(RunAlreadyActive);
    });

    it('counts the runs of two backends together', async () => {
      world = await createWorld({ runsPerUser: 2 });
      const a = backend([[writeCall], [writeCall]]);
      const b = backend([[writeCall], [writeCall]]);
      await waitingRun(a);
      await waitingRun(b);
      const session = await world.newSession();
      for (const host of [a, b]) {
        await expect(
          host.useCases.sendMessage.execute({
            principal: jane,
            sessionId: session.id,
            text: 'third',
          }),
        ).rejects.toBeInstanceOf(TooManyActiveRuns);
      }
    });

    it('keeps the queue when the user continues it at the limit', async () => {
      world = await createWorld({ runsPerUser: 2 });
      const host = backend([[writeCall], [writeCall], [writeCall]]);
      const queued = await waitingRun(host);
      await host.useCases.queueMessage.execute({
        principal: jane,
        sessionId: queued.session.id,
        text: 'later',
      });
      await waitingRun(host);
      await host.useCases.cancelRun.execute({
        principal: jane,
        sessionId: queued.session.id,
        runId: queued.handle.runId,
      });
      await waitingRun(host);

      await expect(
        host.useCases.resumeQueue.execute({
          principal: jane,
          sessionId: queued.session.id,
        }),
      ).rejects.toBeInstanceOf(TooManyActiveRuns);
      expect(
        (await world.queue.list(queued.session.id)).map(m => m.text),
      ).toEqual(['later']);
    });
  });

  describe('the rate limit of a model (P-06)', () => {
    it('makes the second call of a minute wait for the next minute, also from another backend', async () => {
      world = await createWorld();
      const limiter = new KnexModelCallLimiter(world.knex);
      const waits: number[] = [];
      let release = () => {};
      const sleep = (ms: number) => {
        waits.push(ms);
        return new Promise<void>(resolve => {
          release = () => {
            world.clock.advance(60);
            resolve();
          };
        });
      };
      const rateLimits = {
        limiter,
        requestsPerMinute: new Map([['default', 1]]),
        sleep,
      };
      const a = backend([[writeCall]], { rateLimits });
      const b = backend([[writeCall]], { rateLimits });

      await waitingRun(a);
      const session = await world.newSession();
      const handle = await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await until(() => waits.length === 1);
      // The fake clock stands at the start of a minute: a full minute to wait.
      expect(waits[0]).toBeGreaterThanOrEqual(60_000);
      expect(b.model.inputs).toHaveLength(0);

      release();
      await drain(handle);
      expect(b.model.inputs).toHaveLength(1);
    });

    it('does not call the model when the run is stopped while it waits for a turn', async () => {
      world = await createWorld();
      const limiter = new KnexModelCallLimiter(world.knex);
      const rateLimits = {
        limiter,
        requestsPerMinute: new Map([['default', 1]]),
        sleep: (_ms: number, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          ),
      };
      const host = backend([[writeCall], [say('never')]], { rateLimits });
      await waitingRun(host);
      const session = await world.newSession();
      const handle = await host.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      await host.useCases.cancelRun.execute({
        principal: jane,
        sessionId: session.id,
        runId: handle.runId,
      });
      await drain(handle);

      expect((await world.runRow(handle.runId)).status).toBe('cancelled');
      expect(host.model.inputs).toHaveLength(1);
    });

    it('does not ask the limiter for a model without requestsPerMinute', async () => {
      world = await createWorld();
      const limiter = { tryAcquire: jest.fn() };
      const host = backend([[say('hi')]], {
        rateLimits: { limiter, requestsPerMinute: new Map() },
      });
      const session = await world.newSession();
      await drain(
        await host.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'go',
        }),
      );
      expect(limiter.tryAcquire).not.toHaveBeenCalled();
    });
  });
});

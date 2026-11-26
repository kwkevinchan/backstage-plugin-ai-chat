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
  ScriptedModel,
  usedTokens,
  waitForAbort,
} from '@kwkevinchan/ai-chat-harness/testing';
import type { Extensions, ModelClient } from '@kwkevinchan/ai-chat-harness';
import { mockServices } from '@backstage/backend-test-utils';
import { AiChatHarnessRegistry } from '../adapters/backstage/AiChatHarnessRegistry';
import { TITLE_PROMPT_MARK } from '../application';
import type { Metrics } from '../application/ports';
import { IMAGES } from '../__testUtils__/images';
import {
  createWorld,
  drain,
  jane,
  RecordingMetrics,
  until,
} from './__testUtils__';

type World = Awaited<ReturnType<typeof createWorld>>;

/** A string that must never reach a log line or a metric. */
const CANARY = 'CANARY-7f3a9e';

/** The value of a field that `aiChat.toolOutput` hides (T-09). */
const MASKED = 'MASKED-91c2d0';

/** The attributes each metric may have (O-01). */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  'ai_chat.model.duration': ['agent', 'model', 'purpose', 'outcome'],
  'ai_chat.model.tokens': ['agent', 'model', 'purpose', 'type'],
  'ai_chat.context.tokens': ['agent', 'part'],
  'ai_chat.context_provider.results': ['agent', 'provider', 'status'],
  'ai_chat.tool.calls': ['agent', 'tool', 'status', 'reason'],
  'ai_chat.tool.duration': ['agent', 'tool', 'status'],
  'ai_chat.model.rate_limit.wait': ['model', 'outcome'],
  'ai_chat.run.duration': ['agent', 'status', 'end_reason'],
  'ai_chat.run.steps': ['agent', 'status'],
  'ai_chat.run.tool_calls': ['agent', 'status'],
};

/** Every call of a logger mock: message and meta. */
function logCalls(logger: Record<string, unknown>) {
  return ['debug', 'info', 'warn', 'error'].flatMap(
    level =>
      ((logger[level] as jest.Mock | undefined)?.mock.calls ?? []).map(
        args => ({ level, args }),
      ) as { level: string; args: unknown[] }[],
  );
}

describe('observability of the runs (O-01)', () => {
  let world: World;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  beforeEach(async () => {
    world = await createWorld({
      agents: {
        canary: {
          title: 'Canary',
          systemPrompt: `Keep this to yourself: ${CANARY}`,
          skills: ['notes'],
        },
      },
      toolOutput: [{ pattern: 'demo:read', redact: ['token'] }],
    });
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

  it('puts nothing of the conversation, the prompt, the tools or the errors in any log line or metric', async () => {
    const metrics = new RecordingMetrics();
    (
      world.actions.actions.find(a => a.id === 'demo:read') as unknown as {
        output: unknown;
      }
    ).output = { secret: CANARY, token: MASKED };
    const invoke = world.actions.invoke;
    world.actions.invoke = async options => {
      if ((options.input as { name?: string } | undefined)?.name === 'fail') {
        throw new Error(
          `The service at https://internal.example/${CANARY} failed`,
        );
      }
      return invoke(options);
    };
    const extensions: Extensions = {
      skills: [
        {
          id: 'notes',
          description: `Notes ${CANARY}`,
          load: () => `The notes say ${CANARY}`,
        },
      ],
      contextProviders: [
        { id: 'team', provide: () => `The team is ${CANARY}` },
        {
          id: 'broken',
          provide: () => {
            throw new Error(`provider failed with ${CANARY}`);
          },
        },
      ],
      hooks: {
        beforeToolCall: [
          call =>
            call.toolId === 'demo:write'
              ? { action: 'deny', reason: `Refused: ${CANARY}` }
              : { action: 'continue' },
        ],
        afterToolCall: [
          (_call, output) => ({ ...output, message: `changed ${CANARY}` }),
        ],
      },
    };
    // The first run ends the normal way, so the session gets a title: that
    // call of the model fails with the canary in its message.
    let titles = 0;
    const scripted = new ScriptedModel([
      [
        say(`I will look. ${CANARY}`),
        callTool('m1', 'demo:read', { name: CANARY }),
        callTool('m2', 'demo:read', { name: 'fail' }),
        callTool('m3', 'demo:write', { name: CANARY }),
        callTool('m4', 'load_skill', { id: 'notes' }),
        // A tool that is not offered: its name is text of the model.
        callTool('m5', CANARY, {}),
        callTool('m6', 'update_plan', {
          items: [{ text: `Plan ${CANARY}`, status: 'pending' }],
        }),
        usedTokens(321, 12),
      ],
      [say(`Done ${CANARY}`), usedTokens(400, 5)],
      Object.assign(new Error(`401: the key ${CANARY} is not valid`), {
        status: 401,
      }),
    ]);
    const model: ModelClient = {
      capabilities: scripted.capabilities,
      async *stream(input, opts) {
        if (input.system.startsWith(TITLE_PROMPT_MARK)) {
          titles += 1;
          throw new Error(`title failed: ${CANARY}`);
        }
        yield* scripted.stream(input, opts);
      },
    };
    const host = backend([], { extensions, metrics, model });

    // The token of the user, as the request carries it.
    const user = {
      ...jane,
      credentials: { ...(jane.credentials as object), token: `t-${CANARY}` },
    };
    const session = await world.newSession(jane, 'canary');
    const image = await world.attachments.put({
      sessionId: session.id,
      ownerRef: jane.userRef,
      mediaType: 'image/png',
      name: `${CANARY}.png`,
      bytes: IMAGES['image/png'],
      maxPending: 100,
    });
    const first = await host.useCases.sendMessage.execute({
      principal: user,
      sessionId: session.id,
      text: `Look at ${CANARY}`,
      attachmentIds: [image.id],
      page: {
        path: `/catalog/default/component/${CANARY}`,
        entityRef: `component:default/${CANARY}`,
      },
    });
    const firstEvents = await drain(first);
    expect(firstEvents[firstEvents.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    await until(() => titles === 1);
    await until(() =>
      logCalls(host.logger as never).some(
        c => c.args[0] === 'Could not name the session',
      ),
    );

    await world.sessions.update(session.id, { title: `Title ${CANARY}` });
    const second = await host.useCases.sendMessage.execute({
      principal: user,
      sessionId: session.id,
      text: `Again ${CANARY}`,
    });
    const secondEvents = await drain(second);
    expect(secondEvents[secondEvents.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'failed' },
    });
    await until(() => metrics.of('ai_chat.run.duration').length === 2);

    // The measurements are there…
    const lines = logCalls(host.logger as never);
    const messages = lines.map(c => c.args[0]);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Model call',
        'Tool call',
        'Run ended',
        'A run failed',
        'Could not name the session',
      ]),
    );
    const tools = lines
      .filter(c => c.args[0] === 'Tool call')
      .map(c => c.args[1] as Record<string, unknown>);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolId: 'demo:read', status: 'ok' }),
        expect.objectContaining({ toolId: 'demo:read', status: 'error' }),
        expect.objectContaining({
          toolId: 'demo:write',
          status: 'denied',
          reason: 'hook',
        }),
        expect.objectContaining({ toolId: 'load_skill', status: 'ok' }),
        expect.objectContaining({ toolId: 'unknown', status: 'invalid' }),
        expect.objectContaining({ toolId: 'update_plan', status: 'ok' }),
      ]),
    );
    const models = lines
      .filter(c => c.args[0] === 'Model call')
      .map(c => c.args[1] as Record<string, unknown>);
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: 'step',
          step: 1,
          modelId: 'default',
          inputTokens: 321,
          outputTokens: 12,
          providers: expect.arrayContaining([
            { id: 'team', status: 'ok', chars: expect.any(Number) },
            { id: 'broken', status: 'failed', chars: 0 },
          ]),
        }),
        expect.objectContaining({ purpose: 'title', outcome: 'failed' }),
        expect.objectContaining({
          purpose: 'step',
          outcome: 'failed',
          errorStatus: 401,
        }),
      ]),
    );
    expect(lines.find(c => c.args[0] === 'A run failed')?.args[1]).toEqual({
      runId: expect.any(String),
      errorName: 'Error',
      errorStatus: 401,
    });

    // The hidden field is hidden where it is stored.
    expect(JSON.stringify(await world.items.read(session.id))).not.toContain(
      MASKED,
    );

    // …and the canary is nowhere in them.
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(JSON.stringify(lines)).not.toContain('internal.example');
    expect(JSON.stringify(lines)).not.toContain(MASKED);
    expect(JSON.stringify(metrics.measurements)).not.toContain(MASKED);
    expect(JSON.stringify(metrics.instruments)).not.toContain(CANARY);
    expect(JSON.stringify(metrics.measurements)).not.toContain(CANARY);
    expect(JSON.stringify(metrics.measurements)).not.toContain(jane.userRef);

    // The attributes of every metric are the ones of its table.
    for (const { name, attributes } of metrics.measurements) {
      expect(ALLOWED_ATTRIBUTES[name]).toBeDefined();
      for (const key of Object.keys(attributes)) {
        expect([name, ALLOWED_ATTRIBUTES[name].includes(key)]).toEqual([
          name,
          true,
        ]);
      }
    }
    for (const { name } of metrics.instruments) {
      expect(ALLOWED_ATTRIBUTES[name]).toBeDefined();
    }
  });

  it('logs a summary that fails with the name and the status of its error, not its text', async () => {
    await world.cleanup();
    world = await createWorld({
      budget: { tokenBudget: 2500, keepRecentSteps: 1 },
    });
    // Long answers: the old steps do not fit, and no output can be shortened.
    const long = (n: number) => say(`${n} `.repeat(2000));
    const b = backend([
      [long(1)],
      [long(2)],
      // The summary before the step of the third message.
      Object.assign(new Error(`summary refused: ${CANARY}`), { status: 429 }),
      [say('Third answer.')],
    ]);
    const session = await world.newSession();
    for (const text of ['one', 'two', 'three']) {
      await drain(
        await b.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text,
        }),
      );
    }

    const lines = logCalls(b.logger as never);
    const failed = lines.find(c => c.args[0] === 'A summary could not be made');
    expect(failed?.args[1]).toEqual({
      runId: expect.any(String),
      errorName: 'Error',
      errorStatus: 429,
    });
    expect(
      lines.filter(
        c =>
          c.args[0] === 'Model call' &&
          (c.args[1] as { purpose: string }).purpose === 'summary',
      ),
    ).toEqual([
      expect.objectContaining({
        args: [
          'Model call',
          expect.objectContaining({ outcome: 'failed', errorStatus: 429 }),
        ],
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  it('logs a hook and a context provider of a module that throw with the name of the error, not its text', async () => {
    const registryLogger = mockServices.logger.mock();
    const registry = new AiChatHarnessRegistry();
    registry.addHook('beforeToolCall', () => {
      throw new Error(`hook failed reading ${CANARY}`);
    });
    registry.addHook('afterToolCall', () => {
      throw new Error(`after hook failed with ${CANARY}`);
    });
    registry.addContextProvider({
      id: 'oncall',
      provide: () => {
        throw new Error(`provider failed reading ${CANARY}`);
      },
    });
    const b = backend(
      [
        [
          callTool('m1', 'demo:read', { name: 'a' }),
          callTool('m2', 'demo:read', { name: 'b' }),
        ],
        [say('Done.')],
      ],
      {
        extensions: registry.extensions({
          logger: registryLogger,
          maxToolOutputChars: 20000,
        }),
        metrics: new RecordingMetrics(),
      },
    );
    const session = await world.newSession();
    const events = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'Look',
      }),
    );
    expect(events[events.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });

    const registryLines = logCalls(registryLogger as never);
    expect(registryLines.map(c => c.args[0])).toEqual(
      expect.arrayContaining([
        'An AI chat beforeToolCall hook failed',
        'An AI chat context provider failed',
      ]),
    );
    expect(
      registryLines.find(
        c => c.args[0] === 'An AI chat context provider failed',
      )?.args[1],
    ).toEqual({
      contextProvider: 'oncall',
      runId: expect.any(String),
      errorName: 'Error',
    });
    const all = JSON.stringify([
      ...registryLines,
      ...logCalls(b.logger as never),
    ]);
    expect(all).not.toContain(CANARY);
  });

  it('records each run once when it ends, without onRunEnd hooks, and not while it waits for an approval', async () => {
    const metrics = new RecordingMetrics();
    const b = backend(
      [[callTool('m1', 'demo:write', { name: 'w' })], [say('Written.')]],
      { metrics },
    );
    const session = await world.newSession();
    const first = await b.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'Change it',
    });
    await drain(first);
    expect(metrics.of('ai_chat.run.duration')).toEqual([]);
    expect(
      logCalls(b.logger as never).filter(c => c.args[0] === 'Run ended'),
    ).toEqual([]);

    const [pending] = (await world.items.read(session.id)).filter(
      i => i.kind === 'tool_call',
    );
    const decided = await b.useCases.decideApproval.execute({
      principal: jane,
      sessionId: session.id,
      callId: pending.callId,
      decision: 'allow',
    });
    await drain(decided.run!);

    await until(() => metrics.of('ai_chat.run.duration').length === 1);
    expect(metrics.of('ai_chat.run.duration')[0].attributes).toEqual({
      agent: 'default',
      status: 'completed',
    });
    expect(metrics.of('ai_chat.run.steps')[0]).toMatchObject({
      value: 2,
      attributes: { agent: 'default', status: 'completed' },
    });
    expect(metrics.of('ai_chat.run.tool_calls')[0].value).toBe(1);
    const ended = logCalls(b.logger as never).filter(
      c => c.args[0] === 'Run ended',
    );
    expect(ended).toHaveLength(1);
    expect(ended[0].args[1]).toMatchObject({
      sessionId: session.id,
      agentId: 'default',
      status: 'completed',
      stepsUsed: 2,
      toolCallsUsed: 1,
    });
    expect(metrics.of('ai_chat.tool.calls')).toEqual([
      {
        name: 'ai_chat.tool.calls',
        value: 1,
        attributes: { agent: 'default', tool: 'demo:write', status: 'ok' },
      },
    ]);
  });

  it('records a run the user cancels while it waits for an approval', async () => {
    const metrics = new RecordingMetrics();
    const b = backend([[callTool('m1', 'demo:write', { name: 'w' })]], {
      metrics,
    });
    const session = await world.newSession();
    const handle = await b.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'Change it',
    });
    await drain(handle);
    await b.useCases.cancelRun.execute({
      principal: jane,
      sessionId: session.id,
      runId: handle.runId,
    });

    await until(() => metrics.of('ai_chat.run.duration').length === 1);
    expect(metrics.of('ai_chat.run.duration')[0].attributes).toMatchObject({
      status: 'cancelled',
    });
  });

  it('records a run that ExpireStaleRuns of two backends ends, once', async () => {
    const metrics = new RecordingMetrics();
    const crashed = backend([waitForAbort]);
    const b = backend([], { metrics });
    const c = backend([], { metrics });
    const session = await world.newSession();
    const handle = await crashed.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'long',
    });
    await until(() => crashed.model.inputs.length === 1);
    world.clock.advance(31);

    await Promise.all([
      b.useCases.expireStaleRuns.execute(),
      c.useCases.expireStaleRuns.execute(),
    ]);

    await until(() => metrics.of('ai_chat.run.duration').length === 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(metrics.of('ai_chat.run.duration')).toEqual([
      expect.objectContaining({
        attributes: {
          agent: 'default',
          status: 'expired',
          end_reason: 'lease_expired',
        },
      }),
    ]);
    const ended = [b, c].flatMap(host =>
      logCalls(host.logger as never).filter(l => l.args[0] === 'Run ended'),
    );
    expect(ended).toHaveLength(1);
    expect(ended[0].args[1]).toMatchObject({ runId: handle.runId });
  });

  it('records a run that waited for an approval and could not be carried on', async () => {
    const metrics = new RecordingMetrics();
    const a = backend([[callTool('m1', 'demo:write', { name: 'w' })]], {
      metrics,
    });
    const session = await world.newSession();
    const handle = await a.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'go',
    });
    await drain(handle);
    const [pending] = (await world.items.read(session.id)).filter(
      i => i.kind === 'tool_call',
    );
    // The agent of the session is gone, so the loop cannot start again.
    await world.knex('sessions').where({ id: session.id }).update({
      agent_id: 'removed',
    });
    await expect(
      a.useCases.decideApproval.execute({
        principal: jane,
        sessionId: session.id,
        callId: pending.callId,
        decision: 'allow',
      }),
    ).rejects.toThrow();

    await until(() => metrics.of('ai_chat.run.duration').length === 1);
    expect(metrics.of('ai_chat.run.duration')[0].attributes).toEqual({
      agent: 'removed',
      status: 'failed',
      end_reason: 'not_started',
    });
  });

  it('records the run when an onRunEnd hook throws', async () => {
    const metrics = new RecordingMetrics();
    const b = backend([[say('Done.')]], {
      metrics,
      extensions: {
        hooks: {
          onRunEnd: [
            () => {
              throw new Error('hook down');
            },
          ],
        },
      },
    });
    const session = await world.newSession();
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'Hi',
      }),
    );
    await until(() => metrics.of('ai_chat.run.duration').length === 1);
    expect(metrics.of('ai_chat.run.duration')[0].attributes).toMatchObject({
      status: 'completed',
    });
  });

  it('keeps the run going when the metrics fail, and says so once', async () => {
    const failing: Metrics = {
      counter: () => ({
        add: () => {
          throw new Error('metrics down');
        },
      }),
      histogram: () => ({
        record: () => {
          throw new Error('metrics down');
        },
      }),
    };
    const b = backend(
      [[callTool('m1', 'demo:read', { name: 'r' })], [say('Done.')]],
      { metrics: failing },
    );
    const session = await world.newSession();
    const events = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'Look',
      }),
    );

    expect(events[events.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    const warnings = logCalls(b.logger as never).filter(
      c => c.args[0] === 'Could not record a measurement of the AI chat',
    );
    expect(warnings).toHaveLength(1);
  });
});

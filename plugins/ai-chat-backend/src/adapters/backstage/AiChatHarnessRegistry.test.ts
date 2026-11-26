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
import type {
  ContextProvider,
  RunSummary,
  StepContext,
  ToolCall,
} from '@kwkevinchan/ai-chat-harness';
import { AiChatHarnessRegistry } from './AiChatHarnessRegistry';

const logger = mockServices.logger.mock();
const stepContext: StepContext = {
  sessionId: 's',
  runId: 'r',
  principal: {},
  agentId: 'default',
  step: 1,
  signal: new AbortController().signal,
};
const toolCall: ToolCall = {
  callId: 'c',
  toolId: 'demo:read',
  input: {},
  readOnly: true,
  step: 1,
  position: 0,
};
const summary: RunSummary = {
  sessionId: 's',
  runId: 'r',
  agentId: 'default',
  userRef: 'user:default/jane',
  status: 'completed',
  usage: { stepsUsed: 1, toolCallsUsed: 0, elapsedSeconds: 1 },
};

function extensionsOf(registry: AiChatHarnessRegistry) {
  return registry.extensions({ logger, maxToolOutputChars: 100 }).hooks!;
}

describe('AiChatHarnessRegistry', () => {
  it('returns the agents in registration order', () => {
    const registry = new AiChatHarnessRegistry();
    registry.addAgent({
      id: 'guide',
      systemPrompt: 'You help people on example.com.',
      skills: ['getting-started'],
      planning: 'required',
    });
    registry.addAgent({
      id: 'docs',
      systemPrompt: 'You look up pages on example.com.',
    });

    expect(registry.agents()).toEqual([
      {
        id: 'guide',
        systemPrompt: 'You help people on example.com.',
        skills: ['getting-started'],
        planning: 'required',
      },
      {
        id: 'docs',
        systemPrompt: 'You look up pages on example.com.',
      },
    ]);
  });

  it('rejects a repeated agent', () => {
    const registry = new AiChatHarnessRegistry();
    registry.addAgent({ id: 'guide', systemPrompt: 'Keep this one.' });
    expect(() =>
      registry.addAgent({ id: 'guide', systemPrompt: 'Replace it.' }),
    ).toThrow('agent guide is already registered');
    expect(registry.agents()[0].systemPrompt).toBe('Keep this one.');
  });

  it('keeps multiple hooks per phase in registration order and exposes Extensions', async () => {
    const registry = new AiChatHarnessRegistry();
    const first = jest.fn();
    const second = jest.fn();
    const onEnd = jest.fn();

    registry.addHook('beforeModelCall', first);
    registry.addHook('beforeModelCall', second);
    registry.addHook('onRunEnd', onEnd);

    expect(registry.hookCount()).toBe(3);
    const hooks = extensionsOf(registry);
    expect(hooks.beforeModelCall).toHaveLength(2);
    expect(hooks.onRunEnd).toHaveLength(1);
    await hooks.beforeModelCall![1](stepContext);
    expect(second).toHaveBeenCalledWith(stepContext);
    expect(first).not.toHaveBeenCalled();
    await hooks.onRunEnd![0](summary);
    expect(onEnd).toHaveBeenCalledWith(summary);
  });

  it('calls the hooks in order through extensions, and adds nothing when no afterToolCall hook is registered', async () => {
    const registry = new AiChatHarnessRegistry();
    const trace: string[] = [];
    registry.addHook('beforeModelCall', () => void trace.push('first'));
    registry.addHook('beforeModelCall', () => void trace.push('second'));
    registry.addHook('onRunEnd', () => void trace.push('end'));

    const { hooks } = registry.extensions({
      logger: mockServices.logger.mock(),
      maxToolOutputChars: 100,
    });
    expect(hooks?.beforeModelCall).toHaveLength(2);
    expect(hooks?.beforeToolCall).toHaveLength(0);
    expect(hooks?.afterToolCall).toHaveLength(0);
    expect(hooks?.onRunEnd).toHaveLength(1);
    for (const hook of hooks!.beforeModelCall!) await hook(stepContext);
    await hooks!.onRunEnd![0](summary);
    expect(trace).toEqual(['first', 'second', 'end']);
  });

  it.each<
    [
      string,
      (registry: AiChatHarnessRegistry) => Promise<unknown>,
      Record<string, string>,
    ]
  >([
    [
      'beforeModelCall',
      async registry => {
        registry.addHook('beforeModelCall', () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).beforeModelCall![0](stepContext);
      },
      { runId: 'r' },
    ],
    [
      'beforeToolCall',
      async registry => {
        registry.addHook('beforeToolCall', async () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).beforeToolCall![0](toolCall, stepContext);
      },
      { runId: 'r', callId: 'c' },
    ],
    [
      'afterToolCall',
      async registry => {
        registry.addHook('afterToolCall', () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).afterToolCall![0](toolCall, {
          status: 'ok',
        });
      },
      { callId: 'c' },
    ],
    [
      'onRunEnd',
      async registry => {
        registry.addHook('onRunEnd', () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).onRunEnd![0](summary);
      },
      { runId: 'r' },
    ],
  ])(
    'logs a %s hook that throws with its name, and throws again',
    async (name, run, where) => {
      const registry = new AiChatHarnessRegistry();
      await expect(run(registry)).rejects.toThrow('quota service down');
      expect(logger.warn).toHaveBeenCalledWith(
        `An AI chat ${name} hook failed`,
        { hook: name, ...where, error: 'quota service down' },
      );
    },
  );

  it('cuts the output of the last afterToolCall hook to maxToolOutputChars', async () => {
    const registry = new AiChatHarnessRegistry();
    registry.addHook('afterToolCall', (_call, result) => ({
      ...result,
      output: { padding: 'x'.repeat(500) },
    }));
    const { afterToolCall } = registry.extensions({
      logger: mockServices.logger.mock(),
      maxToolOutputChars: 100,
    }).hooks!;
    expect(afterToolCall).toHaveLength(2);

    let result = await afterToolCall![0](toolCall, { status: 'ok' });
    result = await afterToolCall![1](toolCall, result);
    expect(result).toMatchObject({ status: 'ok', truncated: true });
    expect(JSON.stringify(result.output).length).toBeLessThanOrEqual(100);

    const short = { status: 'ok' as const, output: { a: 1 } };
    expect(await afterToolCall![1](toolCall, short)).toBe(short);
  });

  it('rejects unknown hook names and non-function hooks', () => {
    const registry = new AiChatHarnessRegistry();
    expect(() =>
      registry.addHook('afterModelCall' as never, jest.fn() as never),
    ).toThrow('unknown hook: afterModelCall');
    expect(() =>
      registry.addHook('beforeToolCall', 'not a fn' as never),
    ).toThrow('hook beforeToolCall must be a function');
  });

  it('registers skills in order with normalized single-line descriptions and rejects invalid or duplicate skills', async () => {
    const registry = new AiChatHarnessRegistry();
    registry.addSkill({
      id: 'deploy-failure',
      description: '  Debug\n  deployments on example.com. ',
      load: async ctx => `loaded:${ctx.agentId}:${ctx.step}`,
    });
    registry.addSkill({
      id: 'rollback',
      description: 'Roll back a service.',
      load: () => 'rollback body',
    });

    const skills = registry.skills();
    expect(skills.map(s => [s.id, s.description])).toEqual([
      ['deploy-failure', 'Debug deployments on example.com.'],
      ['rollback', 'Roll back a service.'],
    ]);
    await expect(
      skills[0].load({
        sessionId: 's1',
        runId: 'r1',
        agentId: 'sre',
        step: 2,
        principal: { user: 'u' },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('loaded:sre:2');

    expect(() =>
      registry.addSkill({
        id: 'deploy-failure',
        description: 'Duplicate',
        load: () => 'x',
      }),
    ).toThrow('skill deploy-failure is already registered');

    expect(() =>
      registry.addSkill({
        id: 'bad id',
        description: 'Bad',
        load: () => 'x',
      }),
    ).toThrow(/skill bad id/);

    expect(() =>
      registry.addSkill({
        id: 'empty-desc',
        description: '   ',
        load: () => 'x',
      }),
    ).toThrow(/description must not be empty/);

    expect(() =>
      registry.addSkill({
        id: 'no-fn',
        description: 'Missing loader',
        load: 'not-a-fn' as never,
      }),
    ).toThrow(/load must be a function/);
  });

  describe('addModelClient (X-09)', () => {
    const client = {
      capabilities: { parallelToolCalls: false, images: true },
      async *stream() {
        yield { type: 'text' as const, text: 'x' };
      },
    };

    it('keeps the clients by id', () => {
      const registry = new AiChatHarnessRegistry();
      registry.addModelClient('echo', client);
      expect([...registry.modelClients()]).toEqual([['echo', client]]);
    });

    it('refuses an id twice, an id of the wrong form, and a client of the wrong shape', () => {
      const registry = new AiChatHarnessRegistry();
      registry.addModelClient('echo', client);
      expect(() => registry.addModelClient('echo', client)).toThrow(
        'model client echo is already registered',
      );
      expect(() => registry.addModelClient('bad id', client)).toThrow(
        'model client bad id: the id must start with a letter',
      );
      expect(() =>
        registry.addModelClient('a', {
          capabilities: client.capabilities,
        } as never),
      ).toThrow('model client a must have a stream function');
      expect(() =>
        registry.addModelClient('b', { stream: client.stream } as never),
      ).toThrow('model client b must have a stream function');
      expect(() =>
        registry.addModelClient('c', {
          stream: client.stream,
          capabilities: { parallelToolCalls: false },
        } as never),
      ).toThrow('model client c must have a stream function');
      expect([...registry.modelClients().keys()]).toEqual(['echo']);
    });
  });

  describe('context providers (X-03)', () => {
    const provider = (id: string, text = `text of ${id}`): ContextProvider => ({
      id,
      provide: () => text,
    });

    it('lists the built-in providers first, then the ones of the modules in registration order', async () => {
      const registry = new AiChatHarnessRegistry();
      registry.addContextProvider(provider('docs-site'));
      registry.addContextProvider(provider('oncall'));
      const providers = registry.extensions({
        logger,
        maxToolOutputChars: 100,
        builtInContextProviders: [provider('user'), provider('plan')],
      }).contextProviders!;
      expect(providers.map(p => p.id)).toEqual([
        'user',
        'plan',
        'docs-site',
        'oncall',
      ]);
      expect(await providers[2].provide(stepContext)).toBe('text of docs-site');
      expect(registry.contextProviderCount()).toBe(2);
    });

    it.each([
      [
        'a repeated id',
        [provider('docs-site'), provider('docs-site')],
        'context provider docs-site is already registered',
      ],
      [
        'the id of the built-in user',
        [provider('user')],
        'context provider user: the id is taken by a built-in provider',
      ],
      [
        'the id of the built-in entity',
        [provider('entity')],
        'context provider entity: the id is taken',
      ],
      [
        'the id of the built-in plan',
        [provider('plan')],
        'context provider plan: the id is taken',
      ],
      [
        'an id of the wrong form',
        [provider('1-docs')],
        'context provider 1-docs: the id must start with a letter',
      ],
      [
        'an id that is not a string',
        [{ id: 7, provide: (): string => '' }],
        'context provider: id must be a string',
      ],
      [
        'a provide that is not a function',
        [{ id: 'docs', provide: 'x' }],
        'context provider docs: provide must be a function',
      ],
      [
        'a value that is not an object',
        [null],
        'context provider must be an object',
      ],
    ])('refuses %s with an InputError', (_name, values, message) => {
      const registry = new AiChatHarnessRegistry();
      const add = () => {
        for (const value of values) registry.addContextProvider(value as never);
      };
      expect(add).toThrow(expect.objectContaining({ name: 'InputError' }));
      expect(add).toThrow(message);
    });

    it('keeps the first of two providers with the same id', async () => {
      const registry = new AiChatHarnessRegistry();
      registry.addContextProvider(provider('docs-site', 'first'));
      expect(() =>
        registry.addContextProvider(provider('docs-site', 'second')),
      ).toThrow();
      const [only] = registry.extensions({ logger, maxToolOutputChars: 100 })
        .contextProviders!;
      expect(await only.provide(stepContext)).toBe('first');
    });

    it('logs a provider that throws with its id and run, without its text, and throws again', async () => {
      const warn = mockServices.logger.mock();
      const registry = new AiChatHarnessRegistry();
      registry.addContextProvider({
        id: 'oncall',
        provide: () => {
          throw new Error('pager service is down');
        },
      });
      const [wrapped] = registry.extensions({
        logger: warn,
        maxToolOutputChars: 100,
      }).contextProviders!;
      await expect(wrapped.provide(stepContext)).rejects.toThrow(
        'pager service is down',
      );
      expect(warn.warn).toHaveBeenCalledWith(
        'An AI chat context provider failed',
        {
          contextProvider: 'oncall',
          runId: 'r',
          error: 'pager service is down',
        },
      );
    });
  });
});

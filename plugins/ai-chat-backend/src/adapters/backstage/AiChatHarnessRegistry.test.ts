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

  it('keeps multiple hooks per phase in registration order and exposes Extensions', () => {
    const registry = new AiChatHarnessRegistry();
    const first = jest.fn();
    const second = jest.fn();
    const onEnd = jest.fn();

    registry.addHook('beforeModelCall', first);
    registry.addHook('beforeModelCall', second);
    registry.addHook('onRunEnd', onEnd);

    expect(registry.hookCount()).toBe(3);
    expect(registry.hooks()).toEqual({
      beforeModelCall: [first, second],
      beforeToolCall: [],
      afterToolCall: [],
      onRunEnd: [onEnd],
    });
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

  it.each<[string, (registry: AiChatHarnessRegistry) => Promise<unknown>]>([
    [
      'beforeModelCall',
      async registry => {
        registry.addHook('beforeModelCall', () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).beforeModelCall![0](stepContext);
      },
    ],
    [
      'beforeToolCall',
      async registry => {
        registry.addHook('beforeToolCall', async () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).beforeToolCall![0](toolCall, stepContext);
      },
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
    ],
    [
      'onRunEnd',
      async registry => {
        registry.addHook('onRunEnd', () => {
          throw new Error('quota service down');
        });
        return extensionsOf(registry).onRunEnd![0](summary);
      },
    ],
  ])(
    'logs a %s hook that throws with its name, and throws again',
    async (name, run) => {
      const registry = new AiChatHarnessRegistry();
      await expect(run(registry)).rejects.toThrow('quota service down');
      expect(logger.warn).toHaveBeenCalledWith(
        `An AI chat ${name} hook failed`,
        { hook: name, error: 'quota service down' },
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
});

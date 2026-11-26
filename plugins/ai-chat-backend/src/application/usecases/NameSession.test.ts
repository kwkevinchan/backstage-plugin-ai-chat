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
  Item,
  ItemLog,
  ModelClient,
  ModelInput,
  RunOutcome,
} from '@kwkevinchan/ai-chat-harness';
import type { Run, Session } from '../../domain';
import type { Logger, RunRepository, SessionRepository } from '../ports';
import { FakeClock } from '@kwkevinchan/ai-chat-harness/testing';
import type { TitleCallRecord } from '../RunTelemetry';
import { TITLE_PROMPT_MARK, NameSession } from './NameSession';

const session: Session = {
  id: 's1',
  ownerRef: 'user:default/jane',
  agentId: 'default',
  enabledToolsets: [],
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const run: Run = {
  id: 'r1',
  sessionId: 's1',
  status: 'completed',
  usage: { stepsUsed: 1, toolCallsUsed: 0, elapsedSeconds: 1 },
  cancelRequested: false,
  startedAt: '2026-01-01T00:00:00.000Z',
};

const normal: RunOutcome = { status: 'completed' };

const log: Item[] = [
  {
    kind: 'user_message',
    text: 'Why is the build red?',
    sessionId: 's1',
    seq: 1,
    runId: 'r1',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    kind: 'agent_message',
    text: 'The tests failed.',
    sessionId: 's1',
    seq: 2,
    runId: 'r1',
    createdAt: '2026-01-01T00:00:01.000Z',
  },
];

function setup(
  over: {
    title?: string;
    earlier?: boolean;
    reply?: string | Error | 'hang';
    timeoutMs?: number;
    onStream?: () => void | Promise<void>;
    /** Tokens the model reports after its text. */
    usage?: { inputTokens: number; outputTokens: number };
    /** Seconds the fake clock moves while the model answers. */
    takes?: number;
  } = {},
) {
  const clock = new FakeClock();
  const titleCalls: TitleCallRecord[] = [];
  let stored = over.title;
  const sessions = {
    get: jest.fn(async () =>
      stored === undefined ? session : { ...session, title: stored },
    ),
    setTitleIfAbsent: jest.fn(async (_id: string, title: string) => {
      if (stored !== undefined) return false;
      stored = title;
      return true;
    }),
  } as unknown as Pick<SessionRepository, 'get' | 'setTitleIfAbsent'> & {
    setTitleIfAbsent: jest.Mock;
  };
  const runs = {
    hasOtherNormalEnd: jest.fn(async () => over.earlier ?? false),
  } as unknown as Pick<RunRepository, 'hasOtherNormalEnd'>;
  const items = {
    read: jest.fn(async () => log),
  } as unknown as Pick<ItemLog, 'read'>;
  const inputs: ModelInput[] = [];
  const signals: AbortSignal[] = [];
  const model: ModelClient = {
    capabilities: { parallelToolCalls: false, images: false },
    async *stream(input, opts) {
      inputs.push(input);
      signals.push(opts.signal);
      if (over.onStream) await over.onStream();
      if (over.reply === 'hang') {
        await new Promise((_resolve, reject) => {
          if (opts.signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          opts.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
        return;
      }
      if (over.takes) clock.advance(over.takes);
      if (over.reply instanceof Error) throw over.reply;
      yield { type: 'text', text: over.reply ?? '"Build is red"' };
      if (over.usage) yield { type: 'usage', ...over.usage };
    },
  };
  const logger: Logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const name = new NameSession({
    sessions,
    runs,
    items,
    agents: { agent: async agentId => ({ id: agentId, systemPrompt: '' }) },
    models: { forAgent: () => model },
    logger,
    ...(over.timeoutMs !== undefined && { timeoutMs: over.timeoutMs }),
    clock,
    telemetry: { titleCall: record => void titleCalls.push(record) },
  });
  return {
    name,
    titleCalls,
    sessions,
    inputs,
    logger,
    signals,
    title: () => stored,
    setTitle: (title: string) => {
      stored = title;
    },
  };
}

describe('NameSession', () => {
  it('writes a title from the model after the first normal end', async () => {
    const t = setup();
    await t.name.execute({ run, outcome: normal });
    expect(t.title()).toBe('Build is red');
    expect(t.sessions.setTitleIfAbsent).toHaveBeenCalledWith(
      's1',
      'Build is red',
    );
    expect(t.inputs[0].system.startsWith(TITLE_PROMPT_MARK)).toBe(true);
    expect(t.inputs[0].tools).toEqual([]);
    expect(t.inputs[0].messages).toEqual([
      {
        role: 'user',
        content: 'User: Why is the build red?\n\nAssistant: The tests failed.',
      },
    ]);
  });

  it('does not call the model when the session already has a title', async () => {
    const t = setup({ title: 'Mine' });
    await t.name.execute({ run, outcome: normal });
    expect(t.inputs).toEqual([]);
    expect(t.sessions.setTitleIfAbsent).not.toHaveBeenCalled();
    expect(t.title()).toBe('Mine');
  });

  it('does not call the model when an earlier run already ended normally', async () => {
    const t = setup({ earlier: true });
    await t.name.execute({ run, outcome: normal });
    expect(t.inputs).toEqual([]);
    expect(t.title()).toBeUndefined();
  });

  it('does not call the model when the run did not end normally', async () => {
    const t = setup();
    await t.name.execute({
      run,
      outcome: { status: 'completed', endReason: 'max_steps' },
    });
    await t.name.execute({ run, outcome: { status: 'failed', message: 'x' } });
    expect(t.inputs).toEqual([]);
    expect(t.title()).toBeUndefined();
  });

  it('leaves the title unset when the model fails, and does not throw', async () => {
    const t = setup({ reply: new Error('model down') });
    await expect(t.name.execute({ run, outcome: normal })).resolves.toBe(
      undefined,
    );
    expect(t.title()).toBeUndefined();
    expect(t.sessions.setTitleIfAbsent).not.toHaveBeenCalled();
    // The name of the error, not its text: the model server may repeat
    // what the conversation said.
    expect(t.logger.warn).toHaveBeenCalledWith(
      'Could not name the session',
      expect.objectContaining({ errorName: 'Error' }),
    );
    expect(
      JSON.stringify((t.logger.warn as jest.Mock).mock.calls),
    ).not.toContain('model down');
  });

  it('leaves the title unset when the answer is empty', async () => {
    const t = setup({ reply: '   \n  ' });
    await t.name.execute({ run, outcome: normal });
    expect(t.title()).toBeUndefined();
    expect(t.sessions.setTitleIfAbsent).not.toHaveBeenCalled();
  });

  it('gives up when the model does not answer in time, and does not throw', async () => {
    const t = setup({ reply: 'hang', timeoutMs: 20 });
    await expect(t.name.execute({ run, outcome: normal })).resolves.toBe(
      undefined,
    );
    expect(t.title()).toBeUndefined();
    expect(t.signals[0]?.aborted).toBe(true);
    expect(t.logger.warn).toHaveBeenCalledWith(
      'Could not name the session',
      expect.objectContaining({ error: 'timed out' }),
    );
  });

  it('does not replace a title that was set while the model was answering', async () => {
    const over: { onStream?: () => void } = {};
    const t = setup(over);
    over.onStream = () => t.setTitle('Mine');
    await t.name.execute({ run, outcome: normal });
    expect(t.sessions.setTitleIfAbsent).toHaveBeenCalledWith(
      's1',
      'Build is red',
    );
    expect(t.title()).toBe('Mine');
  });

  it('measures the call of the model, with the reported tokens (O-01)', async () => {
    const t = setup({
      usage: { inputTokens: 90, outputTokens: 4 },
      takes: 0.4,
    });
    await t.name.execute({ run, outcome: normal });
    expect(t.titleCalls).toEqual([
      {
        sessionId: 's1',
        runId: run.id,
        agentId: 'default',
        modelId: 'default',
        durationMs: 400,
        outcome: 'ok',
        inputTokens: 90,
        outputTokens: 4,
      },
    ]);
  });

  it('measures a failed call with its status, an empty answer and a timeout (O-01)', async () => {
    const failed = setup({
      reply: Object.assign(new Error('down'), { status: 500 }),
    });
    await failed.name.execute({ run, outcome: normal });
    expect(failed.titleCalls[0]).toMatchObject({
      outcome: 'failed',
      errorStatus: 500,
    });

    const empty = setup({ reply: '   ' });
    await empty.name.execute({ run, outcome: normal });
    expect(empty.titleCalls[0].outcome).toBe('empty');

    const slow = setup({ reply: 'hang', timeoutMs: 10 });
    await slow.name.execute({ run, outcome: normal });
    expect(slow.titleCalls[0].outcome).toBe('timeout');
  });
});

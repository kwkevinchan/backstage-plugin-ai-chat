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
  ModelCallRecord,
  ToolCallRecord,
} from '@kwkevinchan/ai-chat-harness';
import type { Logger, MetricAttributes, MetricOptions, Metrics } from './ports';
import { RunTelemetry } from './RunTelemetry';

/** Metrics that keep every instrument and every measurement. */
class RecordingMetrics implements Metrics {
  readonly instruments: {
    kind: 'counter' | 'histogram';
    name: string;
    options: MetricOptions;
  }[] = [];
  readonly measurements: {
    name: string;
    value: number;
    attributes: MetricAttributes;
  }[] = [];

  counter(name: string, options: MetricOptions) {
    this.instruments.push({ kind: 'counter', name, options });
    return {
      add: (value: number, attributes: MetricAttributes) => {
        this.measurements.push({ name, value, attributes: { ...attributes } });
      },
    };
  }

  histogram(name: string, options: MetricOptions) {
    this.instruments.push({ kind: 'histogram', name, options });
    return {
      record: (value: number, attributes: MetricAttributes) => {
        this.measurements.push({ name, value, attributes: { ...attributes } });
      },
    };
  }

  of(name: string) {
    return this.measurements.filter(m => m.name === name);
  }
}

const logger = (): Logger & Record<'info' | 'warn' | 'error', jest.Mock> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const context: ModelCallRecord['context'] = {
  estimatedTokens: 60,
  budgetTokens: 1000,
  parts: {
    system: 10,
    context: 5,
    tools: 20,
    summary: 0,
    history: 15,
    images: 10,
  },
  messages: 2,
  images: 1,
  tools: 3,
  summarized: false,
  trimmed: ['steps'],
};

const step: ModelCallRecord = {
  sessionId: 's1',
  runId: 'r1',
  agentId: 'sre',
  modelId: 'fast',
  purpose: 'step',
  step: 2,
  durationMs: 1500,
  outcome: 'ok',
  inputTokens: 300,
  outputTokens: 20,
  toolCallsRequested: 1,
  context,
  providers: [{ id: 'team', status: 'cut', chars: 8000 }],
};

describe('RunTelemetry (O-01)', () => {
  it('creates the instruments with their units and buckets', () => {
    const metrics = new RecordingMetrics();
    // eslint-disable-next-line no-new
    new RunTelemetry(metrics, logger());
    expect(
      metrics.instruments.map(i => [i.kind, i.name, i.options.unit]),
    ).toEqual([
      ['histogram', 'ai_chat.model.duration', 's'],
      ['histogram', 'ai_chat.model.tokens', '{token}'],
      ['histogram', 'ai_chat.context.tokens', '{token}'],
      ['counter', 'ai_chat.context_provider.results', '{result}'],
      ['counter', 'ai_chat.tool.calls', '{call}'],
      ['histogram', 'ai_chat.tool.duration', 's'],
      ['histogram', 'ai_chat.model.rate_limit.wait', 's'],
      ['histogram', 'ai_chat.run.duration', 's'],
      ['histogram', 'ai_chat.run.steps', '{step}'],
      ['histogram', 'ai_chat.run.tool_calls', '{call}'],
    ]);
    const duration = metrics.instruments.find(
      i => i.name === 'ai_chat.model.duration',
    );
    expect(duration?.options.buckets?.[0]).toBe(0.01);
    expect(duration?.options.buckets?.slice(-1)).toEqual([600]);
  });

  it('logs a step and records its duration in seconds, its tokens, its context and its providers', () => {
    const metrics = new RecordingMetrics();
    const log = logger();
    new RunTelemetry(metrics, log).modelCall(step);

    expect(log.info).toHaveBeenCalledWith('Model call', {
      sessionId: 's1',
      runId: 'r1',
      agentId: 'sre',
      modelId: 'fast',
      purpose: 'step',
      step: 2,
      durationMs: 1500,
      outcome: 'ok',
      inputTokens: 300,
      outputTokens: 20,
      toolCallsRequested: 1,
      context,
      providers: [{ id: 'team', status: 'cut', chars: 8000 }],
    });
    const model = { agent: 'sre', model: 'fast', purpose: 'step' };
    expect(metrics.of('ai_chat.model.duration')).toEqual([
      {
        name: 'ai_chat.model.duration',
        value: 1.5,
        attributes: { ...model, outcome: 'ok' },
      },
    ]);
    expect(
      metrics.of('ai_chat.model.tokens').map(m => [m.value, m.attributes]),
    ).toEqual([
      [300, { ...model, type: 'input' }],
      [20, { ...model, type: 'output' }],
    ]);
    expect(
      metrics
        .of('ai_chat.context.tokens')
        .map(m => [m.attributes.part, m.value]),
    ).toEqual([
      ['total', 60],
      ['system', 10],
      ['context', 5],
      ['tools', 20],
      ['summary', 0],
      ['history', 15],
      ['images', 10],
    ]);
    expect(metrics.of('ai_chat.context_provider.results')).toEqual([
      {
        name: 'ai_chat.context_provider.results',
        value: 1,
        attributes: { agent: 'sre', provider: 'team', status: 'cut' },
      },
    ]);
  });

  it('copies only the fields it knows into the log line', () => {
    const log = logger();
    new RunTelemetry(new RecordingMetrics(), log).modelCall({
      ...step,
      // A field a later version of the core might add.
      ...({ prompt: 'never logged' } as object),
    } as ModelCallRecord);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('never logged');
  });

  it('records no tokens and no context of a summary when there are none', () => {
    const metrics = new RecordingMetrics();
    const { inputTokens: _i, outputTokens: _o, providers: _p, ...rest } = step;
    new RunTelemetry(metrics, logger()).modelCall({
      ...rest,
      purpose: 'summary',
      outcome: 'failed',
      errorStatus: 503,
    });
    expect(metrics.of('ai_chat.model.tokens')).toEqual([]);
    expect(metrics.of('ai_chat.context.tokens')).toEqual([]);
    expect(metrics.of('ai_chat.model.duration')[0].attributes).toEqual({
      agent: 'sre',
      model: 'fast',
      purpose: 'summary',
      outcome: 'failed',
    });
  });

  it('logs a tool call, counts it, and records the duration only of a call that ran', () => {
    const metrics = new RecordingMetrics();
    const log = logger();
    const telemetry = new RunTelemetry(metrics, log);
    const ran: ToolCallRecord = {
      sessionId: 's1',
      runId: 'r1',
      agentId: 'sre',
      step: 1,
      position: 0,
      callId: 'c1',
      toolId: 'catalog:read',
      readOnly: true,
      status: 'ok',
      durationMs: 250,
      truncated: true,
    };
    telemetry.toolCall(ran);
    telemetry.toolCall({
      ...ran,
      callId: 'c2',
      status: 'denied',
      reason: 'policy',
      durationMs: undefined,
      truncated: undefined,
    });

    expect(log.info).toHaveBeenNthCalledWith(1, 'Tool call', {
      sessionId: 's1',
      runId: 'r1',
      agentId: 'sre',
      step: 1,
      position: 0,
      callId: 'c1',
      toolId: 'catalog:read',
      readOnly: true,
      status: 'ok',
      durationMs: 250,
      truncated: true,
    });
    expect(log.info.mock.calls[1][1]).toMatchObject({
      status: 'denied',
      reason: 'policy',
    });
    expect(metrics.of('ai_chat.tool.calls').map(m => m.attributes)).toEqual([
      { agent: 'sre', tool: 'catalog:read', status: 'ok' },
      {
        agent: 'sre',
        tool: 'catalog:read',
        status: 'denied',
        reason: 'policy',
      },
    ]);
    expect(metrics.of('ai_chat.tool.duration')).toEqual([
      {
        name: 'ai_chat.tool.duration',
        value: 0.25,
        attributes: { agent: 'sre', tool: 'catalog:read', status: 'ok' },
      },
    ]);
  });

  it('logs a run that ended and records its time, steps and tool calls', () => {
    const metrics = new RecordingMetrics();
    const log = logger();
    new RunTelemetry(metrics, log).runEnded({
      sessionId: 's1',
      runId: 'r1',
      agentId: 'sre',
      status: 'completed',
      endReason: 'max_steps',
      usage: { stepsUsed: 10, toolCallsUsed: 4, elapsedSeconds: 12.5 },
    });
    expect(log.info).toHaveBeenCalledWith('Run ended', {
      sessionId: 's1',
      runId: 'r1',
      agentId: 'sre',
      status: 'completed',
      endReason: 'max_steps',
      stepsUsed: 10,
      toolCallsUsed: 4,
      elapsedSeconds: 12.5,
    });
    expect(metrics.of('ai_chat.run.duration')[0]).toMatchObject({
      value: 12.5,
      attributes: {
        agent: 'sre',
        status: 'completed',
        end_reason: 'max_steps',
      },
    });
    expect(metrics.of('ai_chat.run.steps')[0]).toMatchObject({
      value: 10,
      attributes: { agent: 'sre', status: 'completed' },
    });
    expect(metrics.of('ai_chat.run.tool_calls')[0].value).toBe(4);
  });

  it('records the title call and the wait for the rate limit', () => {
    const metrics = new RecordingMetrics();
    const log = logger();
    const telemetry = new RunTelemetry(metrics, log);
    telemetry.titleCall({
      sessionId: 's1',
      runId: 'r1',
      agentId: 'sre',
      modelId: 'default',
      durationMs: 200,
      outcome: 'ok',
      inputTokens: 50,
      outputTokens: 6,
    });
    telemetry.rateLimitWaited({
      modelId: 'default',
      waitMs: 2500,
      outcome: 'acquired',
    });

    expect(log.info).toHaveBeenCalledWith(
      'Model call',
      expect.objectContaining({ purpose: 'title', outcome: 'ok' }),
    );
    expect(metrics.of('ai_chat.model.duration')[0].attributes).toEqual({
      agent: 'sre',
      model: 'default',
      purpose: 'title',
      outcome: 'ok',
    });
    expect(metrics.of('ai_chat.model.tokens')).toHaveLength(2);
    expect(metrics.of('ai_chat.model.rate_limit.wait')).toEqual([
      {
        name: 'ai_chat.model.rate_limit.wait',
        value: 2.5,
        attributes: { model: 'default', outcome: 'acquired' },
      },
    ]);
  });

  it('never throws: a failure of the metrics or of the logger is logged once', () => {
    const log = logger();
    const telemetry = new RunTelemetry(
      {
        counter: () => ({
          add: () => {
            throw new Error('metrics down with secret text');
          },
        }),
        histogram: () => ({
          record: () => {
            throw new Error('metrics down with secret text');
          },
        }),
      },
      log,
    );
    expect(() => telemetry.modelCall(step)).not.toThrow();
    expect(() =>
      telemetry.runEnded({
        sessionId: 's1',
        runId: 'r1',
        agentId: 'sre',
        status: 'failed',
        usage: { stepsUsed: 1, toolCallsUsed: 0, elapsedSeconds: 1 },
      }),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Could not record a measurement of the AI chat',
      { errorName: 'Error' },
    );

    const broken = logger();
    broken.info.mockImplementation(() => {
      throw new Error('logger down');
    });
    broken.warn.mockImplementation(() => {
      throw new Error('logger down');
    });
    expect(() =>
      new RunTelemetry(new RecordingMetrics(), broken).modelCall(step),
    ).not.toThrow();
  });
});

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
  ModelCallOutcome,
  ModelCallRecord,
  RunObserver,
  RunUsage,
  ToolCallRecord,
} from '@kwkevinchan/ai-chat-harness';
import type {
  Logger,
  MetricAttributes,
  MetricCounter,
  MetricHistogram,
  Metrics,
} from './ports';

/** A title of a session made by the model (SE-04), as `NameSession` measures it. */
export type TitleCallRecord = {
  sessionId: string;
  runId: string;
  agentId: string;
  modelId: string;
  durationMs: number;
  outcome: ModelCallOutcome;
  errorStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
};

/** One turn taken from the rate limit of a model (P-06). */
export type RateLimitWaitRecord = {
  modelId: string;
  waitMs: number;
  outcome: 'acquired' | 'cancelled';
};

/** A run that the host wrote in an end state. */
export type RunEndRecord = {
  sessionId: string;
  runId: string;
  agentId: string;
  status: string;
  endReason?: string;
  usage: RunUsage;
};

/** Bucket boundaries in seconds: from 10 ms to the longest run. */
const SECONDS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];

/** Bucket boundaries in tokens. */
const TOKENS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];

/** Bucket boundaries for the steps and the tool calls of a run. */
const COUNTS = [0, 1, 2, 4, 8, 16, 32, 64, 128];

const CONTEXT_PARTS = [
  'system',
  'context',
  'tools',
  'summary',
  'history',
  'images',
] as const;

/**
 * Turns the measurements of the loop and of the host into logs and metrics
 * (O-01). A record holds numbers, ids and fixed words only, and this class
 * copies the fields it knows one by one, so nothing else reaches a log line.
 * The metrics have no session, run, call or user among their attributes: those
 * are in the log lines, where a run can be followed.
 *
 * A failure of the logger or of the metrics is caught and logged once: a
 * measurement never changes a run.
 */
export class RunTelemetry implements RunObserver {
  private readonly modelDuration: MetricHistogram;
  private readonly modelTokens: MetricHistogram;
  private readonly contextTokens: MetricHistogram;
  private readonly providerResults: MetricCounter;
  private readonly toolCalls: MetricCounter;
  private readonly toolDuration: MetricHistogram;
  private readonly rateLimitWait: MetricHistogram;
  private readonly runDuration: MetricHistogram;
  private readonly runSteps: MetricHistogram;
  private readonly runToolCalls: MetricHistogram;
  private failed = false;

  constructor(metrics: Metrics, private readonly logger: Logger) {
    this.modelDuration = metrics.histogram('ai_chat.model.duration', {
      description: 'Duration of the model calls of the AI chat',
      unit: 's',
      buckets: SECONDS,
    });
    this.modelTokens = metrics.histogram('ai_chat.model.tokens', {
      description: 'Tokens the model server reported for one model call',
      unit: '{token}',
      buckets: TOKENS,
    });
    this.contextTokens = metrics.histogram('ai_chat.context.tokens', {
      description: 'Estimated size of the input of one step, by part',
      unit: '{token}',
      buckets: TOKENS,
    });
    this.providerResults = metrics.counter('ai_chat.context_provider.results', {
      description: 'Results of the context providers, one per step',
      unit: '{result}',
    });
    this.toolCalls = metrics.counter('ai_chat.tool.calls', {
      description: 'Tool calls of the AI chat, by result',
      unit: '{call}',
    });
    this.toolDuration = metrics.histogram('ai_chat.tool.duration', {
      description: 'Duration of the tool calls that ran',
      unit: 's',
      buckets: SECONDS,
    });
    this.rateLimitWait = metrics.histogram('ai_chat.model.rate_limit.wait', {
      description: 'Wait for the rate limit of a model before a call',
      unit: 's',
      buckets: SECONDS,
    });
    this.runDuration = metrics.histogram('ai_chat.run.duration', {
      description: 'Working time of a run, without the wait for approvals',
      unit: 's',
      buckets: SECONDS,
    });
    this.runSteps = metrics.histogram('ai_chat.run.steps', {
      description: 'Steps of a run',
      unit: '{step}',
      buckets: COUNTS,
    });
    this.runToolCalls = metrics.histogram('ai_chat.run.tool_calls', {
      description: 'Tool calls of a run',
      unit: '{call}',
      buckets: COUNTS,
    });
  }

  modelCall(record: ModelCallRecord): void {
    this.safely(() => {
      const { context } = record;
      this.logger.info('Model call', {
        sessionId: record.sessionId,
        runId: record.runId,
        agentId: record.agentId,
        ...(record.modelId !== undefined && { modelId: record.modelId }),
        purpose: record.purpose,
        step: record.step,
        durationMs: record.durationMs,
        outcome: record.outcome,
        ...(record.errorStatus !== undefined && {
          errorStatus: record.errorStatus,
        }),
        ...tokensOf(record),
        toolCallsRequested: record.toolCallsRequested,
        context: {
          estimatedTokens: context.estimatedTokens,
          budgetTokens: context.budgetTokens,
          parts: Object.fromEntries(
            CONTEXT_PARTS.map(part => [part, context.parts[part]]),
          ),
          messages: context.messages,
          images: context.images,
          tools: context.tools,
          summarized: context.summarized,
          trimmed: [...context.trimmed],
        },
        ...(record.providers && {
          providers: record.providers.map(p => ({
            id: p.id,
            status: p.status,
            chars: p.chars,
          })),
        }),
      });
      const model = {
        agent: record.agentId,
        ...(record.modelId !== undefined && { model: record.modelId }),
        purpose: record.purpose,
      };
      this.modelDuration.record(record.durationMs / 1000, {
        ...model,
        outcome: record.outcome,
      });
      this.recordTokens(record, model);
      if (record.purpose === 'step') {
        this.contextTokens.record(context.estimatedTokens, {
          agent: record.agentId,
          part: 'total',
        });
        for (const part of CONTEXT_PARTS) {
          this.contextTokens.record(context.parts[part], {
            agent: record.agentId,
            part,
          });
        }
      }
      for (const provider of record.providers ?? []) {
        this.providerResults.add(1, {
          agent: record.agentId,
          provider: provider.id,
          status: provider.status,
        });
      }
    });
  }

  toolCall(record: ToolCallRecord): void {
    this.safely(() => {
      this.logger.info('Tool call', {
        sessionId: record.sessionId,
        runId: record.runId,
        agentId: record.agentId,
        step: record.step,
        position: record.position,
        callId: record.callId,
        toolId: record.toolId,
        readOnly: record.readOnly,
        status: record.status,
        ...(record.reason !== undefined && { reason: record.reason }),
        ...(record.durationMs !== undefined && {
          durationMs: record.durationMs,
        }),
        ...(record.truncated !== undefined && { truncated: record.truncated }),
      });
      this.toolCalls.add(1, {
        agent: record.agentId,
        tool: record.toolId,
        status: record.status,
        ...(record.reason !== undefined && { reason: record.reason }),
      });
      if (record.durationMs !== undefined) {
        this.toolDuration.record(record.durationMs / 1000, {
          agent: record.agentId,
          tool: record.toolId,
          status: record.status,
        });
      }
    });
  }

  titleCall(record: TitleCallRecord): void {
    this.safely(() => {
      this.logger.info('Model call', {
        sessionId: record.sessionId,
        runId: record.runId,
        agentId: record.agentId,
        modelId: record.modelId,
        purpose: 'title',
        durationMs: record.durationMs,
        outcome: record.outcome,
        ...(record.errorStatus !== undefined && {
          errorStatus: record.errorStatus,
        }),
        ...tokensOf(record),
      });
      const model = {
        agent: record.agentId,
        model: record.modelId,
        purpose: 'title',
      };
      this.modelDuration.record(record.durationMs / 1000, {
        ...model,
        outcome: record.outcome,
      });
      this.recordTokens(record, model);
    });
  }

  rateLimitWaited(record: RateLimitWaitRecord): void {
    this.safely(() => {
      this.rateLimitWait.record(record.waitMs / 1000, {
        model: record.modelId,
        outcome: record.outcome,
      });
    });
  }

  runEnded(record: RunEndRecord): void {
    this.safely(() => {
      const { usage } = record;
      this.logger.info('Run ended', {
        sessionId: record.sessionId,
        runId: record.runId,
        agentId: record.agentId,
        status: record.status,
        ...(record.endReason !== undefined && { endReason: record.endReason }),
        stepsUsed: usage.stepsUsed,
        toolCallsUsed: usage.toolCallsUsed,
        elapsedSeconds: usage.elapsedSeconds,
      });
      const run = { agent: record.agentId, status: record.status };
      this.runDuration.record(usage.elapsedSeconds, {
        ...run,
        ...(record.endReason !== undefined && {
          end_reason: record.endReason,
        }),
      });
      this.runSteps.record(usage.stepsUsed, run);
      this.runToolCalls.record(usage.toolCallsUsed, run);
    });
  }

  private recordTokens(
    record: { inputTokens?: number; outputTokens?: number },
    model: MetricAttributes,
  ): void {
    if (record.inputTokens !== undefined) {
      this.modelTokens.record(record.inputTokens, { ...model, type: 'input' });
    }
    if (record.outputTokens !== undefined) {
      this.modelTokens.record(record.outputTokens, {
        ...model,
        type: 'output',
      });
    }
  }

  private safely(measure: () => void): void {
    try {
      measure();
    } catch (error) {
      if (this.failed) return;
      this.failed = true;
      try {
        this.logger.warn('Could not record a measurement of the AI chat', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // The logger is what failed: there is nowhere to say so.
      }
    }
  }
}

function tokensOf(record: { inputTokens?: number; outputTokens?: number }) {
  return {
    ...(record.inputTokens !== undefined && {
      inputTokens: record.inputTokens,
    }),
    ...(record.outputTokens !== undefined && {
      outputTokens: record.outputTokens,
    }),
  };
}

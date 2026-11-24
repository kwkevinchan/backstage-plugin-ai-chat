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
  CallContext,
  JsonObject,
  ToolCallItem,
  ToolDescriptor,
  ToolGateway,
  ToolOutput,
  ValidationResult,
} from '@kwkevinchan/ai-chat-harness';
import type { AuditLog, AuditSpan, Logger } from './ports';

/**
 * A `ToolGateway` that records every run of a tool that is not read-only with
 * the audit log (O-02), whoever started it. The record begins before the tool
 * runs and ends with its result: a result of status `ok` is a success; an
 * `error` or `timeout`, or an exception, is a failure.
 *
 * The loop only calls `execute` for a call that may run, so a call that was
 * denied or that did not pass `validate` leaves no record here; the decision
 * of the user is recorded where it is made (`DecideApproval`).
 */
export class AuditedToolGateway implements ToolGateway {
  constructor(
    private readonly inner: ToolGateway,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
  ) {}

  list(ctx: CallContext): Promise<ToolDescriptor[]> {
    return this.inner.list(ctx);
  }

  validate(
    toolId: string,
    input: JsonObject,
    ctx: CallContext,
  ): Promise<ValidationResult> {
    return this.inner.validate(toolId, input, ctx);
  }

  async execute(
    call: ToolCallItem,
    ctx: CallContext,
    opts: { signal: AbortSignal },
  ): Promise<ToolOutput> {
    if (call.readOnly === true) return this.inner.execute(call, ctx, opts);
    const span = await this.audit.begin({
      eventId: 'tool-call-invoke',
      actorRef: userRefOf(ctx.principal),
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      callId: call.callId,
      toolId: call.toolId,
      readOnly: false,
    });
    let output: ToolOutput;
    try {
      output = await this.inner.execute(call, ctx, opts);
    } catch (error) {
      await this.close(
        span,
        'fail',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    if (output.status === 'ok') {
      await this.close(span, 'success');
    } else {
      await this.close(
        span,
        'fail',
        `The tool ended with status ${output.status}`,
      );
    }
    return output;
  }

  /**
   * Ends the record. A failure of the audit log is logged and nothing more:
   * the tool has run, and its result must reach the log of the session.
   */
  private async close(
    span: AuditSpan,
    how: 'success' | 'fail',
    message = '',
  ): Promise<void> {
    try {
      if (how === 'success') await span.success();
      else await span.fail(message);
    } catch (error) {
      this.logger.warn('Could not end an audit record', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function userRefOf(principal: unknown): string {
  const ref = (principal as { userRef?: unknown } | undefined)?.userRef;
  return typeof ref === 'string' ? ref : 'unknown';
}

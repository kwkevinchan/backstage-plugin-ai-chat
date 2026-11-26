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

import type { ModelCatalog } from '../models';
import {
  DuplicateItem,
  decisionOf,
  needsApproval,
  type Clock,
  type ItemLog,
} from '@kwkevinchan/ai-chat-harness';
import {
  assertOwner,
  findToolCall,
  hasResult,
  RunNotWaiting,
  ToolCallNotFound,
  ToolCallNotWaiting,
  type Principal,
} from '../../domain';
import type { RunSettings } from '../buildRunRequest';
import type { ActivityNotifier } from '../notifyActivity';
import { resumeIfDecided } from '../resumeIfDecided';
import type { RunEnded } from '../runEnded';
import type { RunHandle, RunSupervisor } from '../RunSupervisor';
import type {
  AgentCatalog,
  AuditLog,
  Logger,
  RunRepository,
  SessionRepository,
} from '../ports';

/** What a decision led to. */
export type DecisionResult = {
  /**
   * The decision of the call. When the call had been decided already, that
   * earlier decision, not the one of this request (T-07).
   */
  decision: 'allow' | 'deny';
  /**
   * The run, if this request carried it on: it was the last decision the run
   * waited for, and this request got the lease. `undefined` when other calls
   * still wait, or another request carries the run on.
   */
  run?: RunHandle;
};

/**
 * The user allows or denies a tool call that waits for approval (D-05, P-04).
 * Each decision is stored at once. The run goes on when every call that waits
 * has a decision, whichever request made the last one, on any backend.
 */
export class DecideApproval {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items: ItemLog;
      supervisor: RunSupervisor;
      agents: AgentCatalog;
      models: ModelCatalog;
      audit: AuditLog;
      clock: Clock;
      settings: RunSettings;
      notify?: ActivityNotifier;
      logger?: Logger;
      runEnded?: RunEnded;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `ToolCallNotFound`, `RunNotWaiting`,
   * `ToolCallNotWaiting` or `ShuttingDown`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    callId: string;
    decision: 'allow' | 'deny';
    page?: { path: string; entityRef?: string };
  }): Promise<DecisionResult> {
    const { sessions, runs, items } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);

    const log = await items.read(session.id);
    const call = findToolCall(log, input.callId);
    if (!call || call.runId === undefined) {
      throw new ToolCallNotFound(input.callId);
    }
    const run = await runs.findActive(session.id);
    let decision = decisionOf(log, input.callId);

    if (decision === undefined) {
      if (!needsApproval(call) || hasResult(log, input.callId)) {
        throw new ToolCallNotWaiting(input.callId);
      }
      if (!run || run.id !== call.runId || run.status !== 'waiting_approval') {
        throw new RunNotWaiting(call.runId);
      }
      decision = await this.store(input, call, run.id);
    }

    // Also when the call was decided before: a request that died after it
    // stored the decision, and before the run went on, is picked up here.
    if (!run || run.id !== call.runId) return { decision };
    const resumed = await resumeIfDecided(this.deps, {
      session,
      run,
      principal: input.principal,
      page: input.page,
    });
    return { decision, ...(resumed && { run: resumed }) };
  }

  /** Audits and writes the decision. Returns the decision that stands. */
  private async store(
    input: {
      principal: Principal;
      sessionId: string;
      callId: string;
      decision: 'allow' | 'deny';
    },
    call: { toolId: string; readOnly: boolean },
    runId: string,
  ): Promise<'allow' | 'deny'> {
    const { items, audit } = this.deps;
    const span = await audit.begin({
      eventId:
        input.decision === 'allow' ? 'tool-call-approve' : 'tool-call-deny',
      actorRef: input.principal.userRef,
      sessionId: input.sessionId,
      runId,
      callId: input.callId,
      toolId: call.toolId,
      readOnly: call.readOnly,
    });
    try {
      // No lease is needed to write a decision: the run waits, nobody holds it.
      await items.append(
        input.sessionId,
        [
          {
            kind: 'approval',
            callId: input.callId,
            decision: input.decision,
            decidedBy: input.principal.userRef,
          },
        ],
        { runId, leaseOwner: '' },
      );
    } catch (error) {
      if (error instanceof DuplicateItem) {
        // Another request decided the same call first: its decision stands.
        await span.fail('The call had been decided already');
        const existing = decisionOf(
          await items.read(input.sessionId),
          input.callId,
        );
        if (existing) return existing;
      } else {
        await span.fail(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    await span.success();
    return input.decision;
  }
}

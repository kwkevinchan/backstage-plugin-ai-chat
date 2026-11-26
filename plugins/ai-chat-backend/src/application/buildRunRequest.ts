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
  Clock,
  ContextBudget,
  Limits,
} from '@kwkevinchan/ai-chat-harness';
import {
  runLimits,
  type LeasedRun,
  type Principal,
  type Session,
} from '../domain';
import type { ModelCatalog } from './models';
import type { LaunchRequest } from './RunSupervisor';
import type { AgentCatalog } from './ports';

/** The limits and the context budget every run gets, from the configuration. */
export type RunSettings = {
  limits: Limits;
  budget: ContextBudget;
};

/**
 * What the loop needs to run `run` of `session` for `principal`: the agent,
 * the policy of the administrator, the limits (the working time cut to the
 * life of the credentials, see `runLimits`) and the usage so far. The usage is
 * the one stored with the run, so the time spent waiting for an approval is not
 * in it.
 */
export async function buildRunRequest(
  deps: {
    agents: AgentCatalog;
    models: ModelCatalog;
    clock: Clock;
    settings: RunSettings;
  },
  input: {
    session: Session;
    run: LeasedRun;
    principal: Principal;
    page?: { path: string; entityRef?: string };
  },
): Promise<LaunchRequest> {
  const { session, run, principal, page } = input;
  const agent = await deps.agents.agent(session.agentId);
  return {
    agent,
    model: deps.models.forAgent(agent),
    limits: runLimits(
      deps.settings.limits,
      run.usage,
      principal,
      deps.clock.now(),
    ),
    budget: deps.settings.budget,
    policy: await deps.agents.policy(),
    ctx: {
      sessionId: session.id,
      runId: run.id,
      principal,
      ...(page !== undefined && { page }),
    },
    usage: run.usage,
  };
}

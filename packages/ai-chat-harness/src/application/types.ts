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
  AgentDefinition,
  ContextBudget,
  Limits,
  PolicySettings,
  RunUsage,
} from '../domain';
import type { Extensions } from './ports/extensions';
import type { Clock } from './ports/Clock';
import type { IdGenerator } from './ports/IdGenerator';
import type { ItemLog, RunFence } from './ports/ItemLog';
import type { ModelClient } from './ports/ModelClient';
import type { RunControl } from './ports/RunControl';
import type { RunObserver } from './ports/RunObserver';
import type { CallContext, ToolGateway } from './ports/ToolGateway';

/** What `AdvanceRun` needs from outside. @public */
export type AdvanceRunDeps = {
  items: ItemLog;
  tools: ToolGateway;
  run: RunControl;
  clock: Clock;
  ids: IdGenerator;
  extensions: Extensions;
  /** Receives the measurements of the loop (O-01). Nothing is measured without it. */
  observer?: RunObserver;
};

/**
 * One call of the loop for one run.
 *
 * @public
 */
export type AdvanceRunRequest = {
  agent: AgentDefinition;
  /** The client of the model of the agent (X-09). */
  model: ModelClient;
  /** The id of that model; the loop only puts it in its measurements. */
  modelId?: string;
  limits: Limits;
  budget: ContextBudget;
  /** The policy of the administrator; the loop decides every call with it. */
  policy: PolicySettings;
  fence: RunFence;
  ctx: CallContext;
  signal: AbortSignal;
  /**
   * What the run has used before this call: nothing for a new run, the stored
   * usage when an approval resumes it. The working time does not include the
   * time spent waiting for an approval; the host measures that part.
   */
  usage: RunUsage;
};

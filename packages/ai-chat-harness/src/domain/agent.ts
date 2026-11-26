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

/**
 * `required`: the first step of a run offers only `update_plan` (X-07).
 * Absent means the agent does not require a plan.
 *
 * @public
 */
export type PlanningMode = 'required';

/**
 * Limits recorded on an agent (X-01). A missing field uses the limit of the
 * installation. 0 allows nothing. The loop still uses the limits of the run;
 * applying these is later.
 *
 * @public
 */
export type AgentLimits = {
  /** Model calls. */
  maxSteps?: number;
  /** Tool calls the model requested, over the whole run. */
  maxToolCallsPerRun?: number;
  /** Seconds of working time. At most 600, like the installation. */
  runTimeoutSeconds?: number;
};

/**
 * One agent (X-01). The loop applies `systemPrompt`, `skills` (which skills
 * `load_skill` offers) and `planning`. `toolsets`, `model` and `limits` are
 * recorded here; applying them is later work (P3-02 to P3-07).
 *
 * @public
 */
export type AgentDefinition = {
  id: string;
  title?: string;
  systemPrompt: string;
  /** Toolset ids this agent names. */
  toolsets?: readonly string[];
  /** Skill ids. The text of a skill is loaded later (P3-04). */
  skills?: readonly string[];
  /** Id of a model. The client for it is chosen later (P3-07). */
  model?: string;
  limits?: AgentLimits;
  planning?: PlanningMode;
};

/**
 * The limits of one run (H-05). A limit of 0 allows nothing.
 *
 * @public
 */
export type Limits = {
  /** Model calls. */
  maxSteps: number;
  /**
   * Tool calls the model requested, over the whole run. The next-step rules
   * only stop a new model call once the count is reached. They cannot cut the
   * calls of one step, so `callModel` enforces the limit when it writes the
   * calls: a call beyond the remaining count is written with a `denied`
   * result (message "tool call limit") and never runs.
   */
  maxToolCallsPerRun: number;
  /** Seconds of working time, shorter than the lifetime of the user token. */
  runTimeoutSeconds: number;
};

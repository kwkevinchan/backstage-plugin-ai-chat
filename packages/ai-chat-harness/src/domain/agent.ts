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

/** @public */
export type AgentDefinition = {
  id: string;
  title?: string;
  systemPrompt: string;
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

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

import type { AgentDefinition } from '../../domain/agent';
import type { CallContext } from './ToolGateway';

/**
 * Per-step context passed to skills and other extension callbacks (X-02).
 *
 * @public
 */
export interface StepContext extends CallContext {
  agentId: string;
  /** 1-based step index of the call. */
  step: number;
  signal: AbortSignal;
}

/**
 * A reusable instruction set whose name and short description are shown in
 * context and whose full body is loaded lazily via `load_skill` (X-04, D-22).
 *
 * @public
 */
export interface Skill {
  id: string;
  /** One-line summary placed in the step context. */
  description: string;
  /** Returns the full Markdown instructions when the model calls `load_skill`. */
  load(ctx: StepContext): string | Promise<string>;
}

/**
 * What a backend module can add through `aiChatHarnessExtensionPoint` (X-02).
 * Exposes `addAgent` and `addSkill`. Context providers (P3-02), hooks (P3-05)
 * and a model client (P3-07) are added on those later items, together with the
 * loop calling them.
 *
 * @public
 */
export interface AiChatHarnessExtensionPoint {
  addAgent(agent: AgentDefinition): void;
  addSkill(skill: Skill): void;
}

/**
 * The registrations the loop reads. Later items add context providers, hooks
 * and model clients.
 *
 * @public
 */
export type Extensions = {
  readonly skills?: readonly Skill[];
};

/** No registrations. @public */
export function emptyExtensions(): Extensions {
  return {};
}

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

import type { StepContext } from '../ports/extensions';
import type { AdvanceRunRequest } from '../types';

/**
 * A copy of the principal for one call of an extension. The core does not know its
 * shape: the object and its arrays are copied, what they hold is not (the
 * credentials of the host may not be plain data).
 */
function copyPrincipal(principal: unknown): unknown {
  if (typeof principal !== 'object' || principal === null) return principal;
  if (Array.isArray(principal)) return [...principal];
  return Object.fromEntries(
    Object.entries(principal).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}

/**
 * The `StepContext` of step `step` of the run of `req`. Every extension that
 * gets a `StepContext` gets it from here; each call of one gets a copy
 * (`copyStepContext`).
 */
export function stepContextOf(
  req: AdvanceRunRequest,
  step: number,
): StepContext {
  return {
    sessionId: req.ctx.sessionId,
    runId: req.ctx.runId,
    principal: req.ctx.principal,
    ...(req.ctx.page ? { page: { ...req.ctx.page } } : {}),
    agentId: req.agent.id,
    step,
    signal: req.signal,
  };
}

/**
 * A copy of `ctx` for one call of an extension, so that one cannot change
 * what the next one gets.
 */
export function copyStepContext(ctx: StepContext): StepContext {
  return {
    ...ctx,
    principal: copyPrincipal(ctx.principal),
    ...(ctx.page ? { page: { ...ctx.page } } : {}),
  };
}

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
  ChatPlan,
  ChatPlanItemStatus,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';

/** The built-in tool with which the model writes the plan of the session. */
export const UPDATE_PLAN_TOOL = 'update_plan';

const STATUSES: readonly ChatPlanItemStatus[] = [
  'pending',
  'in_progress',
  'completed',
];

/**
 * The plan in the input of an `update_plan` call, as the screen shows it;
 * `undefined` when the input is not a plan (still streaming, or invalid).
 */
export function planOfInput(input: unknown): ChatPlan | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { items } = input as { items?: unknown };
  if (!Array.isArray(items)) return undefined;
  const plan: ChatPlan = { items: [] };
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { text, status } = item as { text?: unknown; status?: unknown };
    if (typeof text !== 'string') return undefined;
    if (!STATUSES.includes(status as ChatPlanItemStatus)) return undefined;
    plan.items.push({ text, status: status as ChatPlanItemStatus });
  }
  return plan;
}

/** How many steps of a plan are completed. */
export function completedCount(plan: ChatPlan): number {
  return plan.items.filter(item => item.status === 'completed').length;
}

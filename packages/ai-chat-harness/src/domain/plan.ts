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

import type { Item } from './item';

/** @public */
export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

/** @public */
export type PlanItem = { text: string; status: PlanItemStatus };

/** The whole plan; an update replaces it. @public */
export type Plan = { items: PlanItem[] };

/**
 * The current plan of a session: the one in the last `plan_update` item.
 *
 * @public
 */
export function currentPlan(items: readonly Item[]): Plan | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'plan_update') {
      return item.plan;
    }
  }
  return undefined;
}

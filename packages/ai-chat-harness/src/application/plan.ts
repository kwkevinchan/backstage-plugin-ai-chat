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

import type { Plan } from '../domain';
import type { ItemLog } from './ports/ItemLog';

/**
 * The current plan of a session (X-06): the plan of its last `plan_update`
 * item, also when a `summary` covers that item and the loop no longer reads
 * it. `undefined` when the model has not written a plan.
 *
 * @public
 */
export async function readCurrentPlan(
  log: Pick<ItemLog, 'latestPlanUpdate'>,
  sessionId: string,
): Promise<Plan | undefined> {
  return (await log.latestPlanUpdate(sessionId))?.plan;
}

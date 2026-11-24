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

import type { ToolCallBody } from './item';
import type { ToolDescriptor } from './tool';

/** @public */
export type PolicyName = 'allow' | 'ask' | 'deny';

/**
 * The policy of the administrator, from the `policy` block of the
 * configuration: the tool id and what to do with it.
 *
 * @public
 */
export type PolicySettings = {
  byTool?: Readonly<Record<string, PolicyName>>;
};

/**
 * What to do with a call of this tool (D-06, T-03, T-04).
 *
 * - `deny` in the settings always wins.
 * - A tool that is not read-only always asks, whatever the settings say.
 * - A read-only tool that sends data out of the organization always asks.
 * - Any other tool runs at once, unless the settings say `ask`.
 *
 * @public
 */
export function decidePolicy(
  tool: ToolDescriptor,
  settings: PolicySettings,
): PolicyName {
  const configured = configuredPolicy(tool.id, settings);
  if (configured === 'deny') {
    return 'deny';
  }
  if (tool.readOnly !== true || tool.egress === true) {
    return 'ask';
  }
  return configured === undefined || configured === 'allow' ? 'allow' : 'ask';
}

function configuredPolicy(
  toolId: string,
  settings: PolicySettings,
): PolicyName | undefined {
  const byTool = settings.byTool;
  if (!byTool || !Object.prototype.hasOwnProperty.call(byTool, toolId)) {
    return undefined;
  }
  return byTool[toolId];
}

/**
 * Whether a call waits for the decision of the user (D-06): its recorded
 * policy is `ask`, or it is not read-only whatever the policy says. The loop
 * and the host use this one rule.
 *
 * @public
 */
export function needsApproval(
  call: Pick<ToolCallBody, 'policy' | 'readOnly'>,
): boolean {
  return call.policy === 'ask' || call.readOnly !== true;
}

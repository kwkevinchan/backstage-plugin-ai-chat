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
  PolicySettings,
} from '@kwkevinchan/ai-chat-harness';
import type { Toolset } from '../../domain';

/**
 * Where the agents, the toolsets and the policy of the administrator come
 * from.
 */
export interface AgentCatalog {
  /** The agent with this id. Throws `AgentNotFound` when there is none. */
  agent(agentId: string): Promise<AgentDefinition>;
  /** The id of the agent a new session has. */
  defaultAgentId(): string;
  /** The toolsets that exist (T-01). */
  toolsets(): Promise<readonly Toolset[]>;
  /** The policy of the administrator (T-03). */
  policy(): Promise<PolicySettings>;
}

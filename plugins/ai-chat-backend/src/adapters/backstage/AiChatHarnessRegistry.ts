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

import { InputError } from '@backstage/errors';
import type {
  AgentDefinition,
  AiChatHarnessExtensionPoint,
} from '@kwkevinchan/ai-chat-harness';
import { readExtensionAgent } from './agentShape';

/**
 * What backend modules add through `aiChatHarnessExtensionPoint` (X-02).
 * The plugin registers this object before the modules run, then reads the
 * agents when it builds the catalog. A repeated id is refused and the first
 * registration stays.
 */
export class AiChatHarnessRegistry implements AiChatHarnessExtensionPoint {
  private readonly agentList: AgentDefinition[] = [];

  addAgent(agent: AgentDefinition): void {
    const checked = readExtensionAgent(agent);
    if (this.agentList.some(existing => existing.id === checked.id)) {
      throw new InputError(`agent ${checked.id} is already registered`);
    }
    this.agentList.push(checked);
  }

  agents(): readonly AgentDefinition[] {
    return [...this.agentList];
  }
}

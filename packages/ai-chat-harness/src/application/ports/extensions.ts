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

/**
 * What a backend module can add (X-02). This version only has `addAgent`.
 * Context providers (P3-02), skills (P3-04), hooks (P3-05) and a model
 * client (P3-07) are added on those later items, together with the loop
 * calling them.
 *
 * @public
 */
export interface AiChatHarnessExtensionPoint {
  addAgent(agent: AgentDefinition): void;
}

/**
 * The registrations the loop will read. Later items fill this in. The loop
 * does not read it yet.
 *
 * @public
 */
export type Extensions = Readonly<Record<string, never>>;

/** No registrations. @public */
export function emptyExtensions(): Extensions {
  return {};
}

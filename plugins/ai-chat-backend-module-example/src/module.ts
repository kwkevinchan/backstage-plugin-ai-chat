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

import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  aiChatHarnessExtensionPoint,
  type AgentDefinition,
  type ContextProvider,
} from '@kwkevinchan/backstage-plugin-ai-chat-node';

const guide: AgentDefinition = {
  id: 'guide',
  title: 'Guide',
  systemPrompt:
    'You help people find documentation on example.com. Answer in the language of the user.',
  skills: ['getting-started'],
  planning: 'required',
};

const site: ContextProvider = {
  id: 'site',
  async provide() {
    return 'The site is example.com.';
  },
};

/**
 * Registers one agent and one context provider. The text mentions
 * `example.com` only. Install it next to the AI chat backend plugin.
 *
 * @public
 */
export const aiChatExampleModule = createBackendModule({
  pluginId: 'ai-chat',
  moduleId: 'example',
  register(env) {
    env.registerInit({
      deps: { harness: aiChatHarnessExtensionPoint },
      async init({ harness }) {
        harness.addAgent(guide);
        harness.addContextProvider(site);
      },
    });
  },
});

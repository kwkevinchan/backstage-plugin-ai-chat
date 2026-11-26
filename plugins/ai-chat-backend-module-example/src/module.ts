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
  type ModelClient,
  type ContextProvider,
  type Skill,
} from '@kwkevinchan/backstage-plugin-ai-chat-node';

const guide: AgentDefinition = {
  id: 'guide',
  title: 'Guide',
  systemPrompt:
    'You help people find documentation on example.com. Answer in the language of the user.',
  skills: ['getting-started'],
  planning: 'required',
};

const gettingStartedSkill: Skill = {
  id: 'getting-started',
  description: 'Walks new readers through documentation on example.com.',
  load: async () =>
    [
      '# Getting started with example.com',
      '',
      '1. Search the Software Catalog to locate the service owner and repository.',
      '2. Check the documentation on example.com for runbooks and architecture notes.',
    ].join('\n'),
};

// Runs before every model call. The text is data for the model, not an
// instruction, and must stay short: it is cut to 8000 characters.
const docsSiteProvider: ContextProvider = {
  id: 'docs-site',
  provide: () =>
    'The documentation of this organization is at https://example.com/docs.',
};

/**
 * A model client that calls no server: it answers with the last message of
 * the user and the size of its images. A real client sends `input` to its
 * model server. The images of a message carry no bytes; `opts.readImage`
 * reads them from the attachments of the session.
 */
const echoModel: ModelClient = {
  capabilities: { parallelToolCalls: false, images: true },
  async *stream(input, opts) {
    const last = [...input.messages]
      .reverse()
      .find(message => message.role === 'user');
    if (!last || last.role !== 'user') {
      yield { type: 'text', text: 'There is no message to answer.' };
      return;
    }
    const sizes: string[] = [];
    for (const image of last.images ?? []) {
      const data = await opts.readImage?.(image);
      sizes.push(data ? `${data.bytes.length} bytes` : 'not available');
    }
    yield {
      type: 'text',
      text: [
        `You wrote: ${last.content}`,
        ...sizes.map((size, i) => `Image ${i + 1}: ${size}`),
      ].join('\n'),
    };
  },
};

/**
 * Registers one agent, one skill, one model client (`example-echo`; no agent
 * of this module uses it) and one context provider. The text mentions
 * `example.com` only.
 * This package is a private example in the repository, to copy from, not to
 * install.
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
        harness.addSkill(gettingStartedSkill);
        harness.addModelClient('example-echo', echoModel);
        harness.addContextProvider(docsSiteProvider);
      },
    });
  },
});

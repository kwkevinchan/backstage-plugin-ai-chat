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

import { AiChatHarnessRegistry } from './AiChatHarnessRegistry';

describe('AiChatHarnessRegistry', () => {
  it('returns the agents in registration order', () => {
    const registry = new AiChatHarnessRegistry();
    registry.addAgent({
      id: 'guide',
      systemPrompt: 'You help people on example.com.',
      skills: ['getting-started'],
      planning: 'required',
    });
    registry.addAgent({
      id: 'docs',
      systemPrompt: 'You look up pages on example.com.',
    });

    expect(registry.agents()).toEqual([
      {
        id: 'guide',
        systemPrompt: 'You help people on example.com.',
        skills: ['getting-started'],
        planning: 'required',
      },
      {
        id: 'docs',
        systemPrompt: 'You look up pages on example.com.',
      },
    ]);
  });

  it('rejects a repeated agent', () => {
    const registry = new AiChatHarnessRegistry();
    registry.addAgent({ id: 'guide', systemPrompt: 'Keep this one.' });
    expect(() =>
      registry.addAgent({ id: 'guide', systemPrompt: 'Replace it.' }),
    ).toThrow('agent guide is already registered');
    expect(registry.agents()[0].systemPrompt).toBe('Keep this one.');
  });
});

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
  ContextProvider,
  ModelClient,
  Skill,
} from '@kwkevinchan/ai-chat-harness';
import { AiChatHarnessRegistry } from './AiChatHarnessRegistry';

const provider = (id: string): ContextProvider => ({
  id,
  provide: async () => id,
});

const skill = (id: string): Skill => ({
  id,
  description: id,
  load: async () => id,
});

const client = (text: string): ModelClient => ({
  capabilities: { parallelToolCalls: false, images: false },
  async *stream() {
    yield { type: 'text', text };
  },
});

describe('AiChatHarnessRegistry', () => {
  it('returns context providers, skills, hooks and model clients in registration order', () => {
    const registry = new AiChatHarnessRegistry();
    const site = provider('site');
    const docs = provider('docs');
    const first = skill('getting-started');
    const second = skill('rollback');
    const beforeA = jest.fn(async () => {});
    const beforeB = jest.fn(async () => {});
    const firstClient = client('one');
    const secondClient = client('two');

    registry.addAgent({
      id: 'guide',
      systemPrompt: 'You help people on example.com.',
      skills: ['getting-started'],
      planning: 'required',
    });
    registry.addContextProvider(site);
    registry.addContextProvider(docs);
    registry.addSkill(first);
    registry.addSkill(second);
    registry.addHook('beforeModelCall', beforeA);
    registry.addHook('beforeModelCall', beforeB);
    registry.setModelClient('default', firstClient);
    registry.setModelClient('other', secondClient);

    expect(registry.agents()).toEqual([
      {
        id: 'guide',
        systemPrompt: 'You help people on example.com.',
        skills: ['getting-started'],
        planning: 'required',
      },
    ]);
    expect(registry.contextProviders()).toEqual([site, docs]);
    expect(registry.skills()).toEqual([first, second]);
    expect(registry.hooks('beforeModelCall')).toEqual([beforeA, beforeB]);
    expect(registry.modelClient('default')).toBe(firstClient);
    expect([...registry.modelClients().keys()]).toEqual(['default', 'other']);
    expect(registry.extensions()).toMatchObject({
      contextProviders: [site, docs],
      skills: [first, second],
      hooks: { beforeModelCall: [beforeA, beforeB] },
    });
  });

  it('rejects a repeated context provider, skill, model client or agent', () => {
    const registry = new AiChatHarnessRegistry();
    const site = provider('site');
    const started = skill('getting-started');
    const first = client('one');
    registry.addContextProvider(site);
    registry.addSkill(started);
    registry.setModelClient('default', first);
    registry.addAgent({ id: 'guide', systemPrompt: 'Keep this one.' });

    expect(() => registry.addContextProvider(provider('site'))).toThrow(
      'context provider site is already registered',
    );
    expect(() => registry.addSkill(skill('getting-started'))).toThrow(
      'skill getting-started is already registered',
    );
    expect(() => registry.setModelClient('default', client('two'))).toThrow(
      'model default is already registered',
    );
    expect(() =>
      registry.addAgent({ id: 'guide', systemPrompt: 'Replace it.' }),
    ).toThrow('agent guide is already registered');

    expect(registry.contextProviders()).toEqual([site]);
    expect(registry.skills()).toEqual([started]);
    expect(registry.modelClient('default')).toBe(first);
    expect(registry.agents()[0].systemPrompt).toBe('Keep this one.');
  });

  it('rejects a hook name that is not one of the four', () => {
    const registry = new AiChatHarnessRegistry();
    expect(() =>
      registry.addHook(
        'afterLunch' as 'beforeModelCall',
        (async () => {}) as never,
      ),
    ).toThrow('unknown hook afterLunch');
  });
});

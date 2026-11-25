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

import { createBackendPlugin } from '@backstage/backend-plugin-api';
import { startTestBackend } from '@backstage/backend-test-utils';
import {
  aiChatHarnessExtensionPoint,
  type AgentDefinition,
  type Skill,
} from '@kwkevinchan/backstage-plugin-ai-chat-node';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { aiChatExampleModule as exampleModule } from './module';

const SPEC = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const ALLOWED = [
  /^@kwkevinchan\/backstage-plugin-ai-chat-node$/,
  /^@backstage\//,
  /^\./,
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts'))
      found.push(path);
  }
  return found;
}

describe('the example module', () => {
  it('does not import the host or the harness', () => {
    const root = resolve(__dirname);
    const files = sourceFiles(root);
    expect(files.map(file => relative(root, file)).sort()).toEqual([
      'index.ts',
      'module.ts',
    ]);
    const specs = files.flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(SPEC)].map(match => ({
        file,
        spec: match[1],
      }));
    });
    expect(specs.length).toBeGreaterThan(0);
    const forbidden = specs.filter(
      ({ spec }) =>
        spec.includes('backstage-plugin-ai-chat-backend') ||
        spec.includes('ai-chat-harness') ||
        !ALLOWED.some(pattern => pattern.test(spec)),
    );
    const outside = specs
      .filter(({ spec }) => spec.startsWith('.'))
      .map(({ file, spec }) => relative(root, resolve(file, '..', spec)))
      .filter(target => target.startsWith('..') || target === '..');
    expect(forbidden).toEqual([]);
    expect(outside).toEqual([]);
  });

  it('registers an agent and a skill for example.com', async () => {
    const agents: AgentDefinition[] = [];
    const skills: Skill[] = [];
    const stub = createBackendPlugin({
      pluginId: 'ai-chat',
      register(env) {
        env.registerExtensionPoint(aiChatHarnessExtensionPoint, {
          addAgent(agent) {
            agents.push(agent);
          },
          addSkill(skill) {
            skills.push(skill);
          },
        });
        // A plugin has to register an init, even when the module does the work.
        env.registerInit({
          deps: {},
          async init() {},
        });
      },
    });

    await startTestBackend({ features: [stub, exampleModule] });

    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.map(agent => agent.id)).toContain('guide');
    expect(
      agents.some(agent => agent.systemPrompt.includes('example.com')),
    ).toBe(true);
    expect(skills.map(skill => skill.id)).toContain('getting-started');
    expect(
      skills.some(skill => skill.description.includes('example.com')),
    ).toBe(true);
  });
});

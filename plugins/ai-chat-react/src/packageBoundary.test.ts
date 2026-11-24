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

import * as published from './index';
import pkg from '../package.json';

describe('ai-chat-react package', () => {
  it('is a web library that depends on the common package only', () => {
    expect(pkg.name).toBe('@kwkevinchan/backstage-plugin-ai-chat-react');
    expect(pkg.backstage.role).toBe('web-library');
    expect(pkg.dependencies).toEqual({
      '@kwkevinchan/backstage-plugin-ai-chat-common': 'workspace:^',
    });
    expect(pkg.dependencies).not.toHaveProperty(
      '@kwkevinchan/backstage-plugin-ai-chat',
    );
    expect(pkg.dependencies).not.toHaveProperty(
      '@kwkevinchan/backstage-plugin-ai-chat-backend',
    );
    expect(pkg.dependencies).not.toHaveProperty('@kwkevinchan/ai-chat-harness');
  });

  it('exports the launcher and the panel hook, and not the later blueprints', () => {
    expect(typeof published.AiChatLauncher).toBe('function');
    expect(typeof published.useAiChatPanel).toBe('function');
    expect('AiChatToolResultBlueprint' in published).toBe(false);
    expect('AiChatClientToolBlueprint' in published).toBe(false);
  });
});

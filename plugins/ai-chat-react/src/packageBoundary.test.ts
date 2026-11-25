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
  it('is a web library that does not depend on other repository packages', () => {
    expect(pkg.name).toBe('@kwkevinchan/backstage-plugin-ai-chat-react');
    expect(pkg.backstage.role).toBe('web-library');
    expect(pkg.dependencies).toEqual({
      '@backstage/core-plugin-api': 'backstage:^',
    });
    expect(pkg.dependencies).not.toHaveProperty(
      '@kwkevinchan/backstage-plugin-ai-chat',
    );
    expect(pkg.dependencies).not.toHaveProperty(
      '@kwkevinchan/backstage-plugin-ai-chat-backend',
    );
    expect(pkg.dependencies).not.toHaveProperty(
      '@kwkevinchan/backstage-plugin-ai-chat-common',
    );
    expect(pkg.dependencies).not.toHaveProperty('@kwkevinchan/ai-chat-harness');
  });

  it('exports only the panel API ref, launcher, and panel hook', () => {
    expect(Object.keys(published).sort()).toEqual([
      'AiChatLauncher',
      'aiChatPanelApiRef',
      'useAiChatPanel',
    ]);
    expect(published.aiChatPanelApiRef.id).toBe('plugin.ai-chat.panel');
    expect(typeof published.AiChatLauncher).toBe('function');
    expect(typeof published.useAiChatPanel).toBe('function');
    expect('AiChatPanelProvider' in published).toBe(false);
    expect('createAiChatPanelStore' in published).toBe(false);
    expect('useAiChatPanelStore' in published).toBe(false);
    expect('launchContextOf' in published).toBe(false);
    expect('panelMessagePage' in published).toBe(false);
    expect('AiChatToolResultBlueprint' in published).toBe(false);
    expect('AiChatClientToolBlueprint' in published).toBe(false);
  });
});

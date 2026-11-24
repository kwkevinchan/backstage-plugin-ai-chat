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

import { coreExtensionData } from '@backstage/frontend-plugin-api';
import { createExtensionTester } from '@backstage/frontend-test-utils';
import aiChatPlugin from './alpha';

describe('ai-chat (new frontend system)', () => {
  it('exports a frontend plugin', () => {
    expect(aiChatPlugin.id).toBe('ai-chat');
  });

  it('adds the chat page with a title and icon for the sidebar', () => {
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('page:ai-chat'),
    );
    expect(tester.get(coreExtensionData.routePath)).toBe('/ai-chat');
    expect(tester.get(coreExtensionData.title)).toBe('AI chat');
    expect(tester.get(coreExtensionData.icon)).toBeTruthy();
  });

  it('adds the API of the chat backend', () => {
    expect(aiChatPlugin.getExtension('api:ai-chat')).toBeDefined();
  });

  it('mounts the side panel at the app root', () => {
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('app-root-element:ai-chat/panel'),
    );
    expect(tester.get(coreExtensionData.reactElement)).toBeTruthy();
  });

  it('lets an app override the page path', () => {
    const overridden = aiChatPlugin.withOverrides({
      extensions: [
        aiChatPlugin
          .getExtension('page:ai-chat')
          .override({ params: { path: '/assistant' } }),
      ],
    });
    const page = createExtensionTester(overridden.getExtension('page:ai-chat'));
    expect(page.get(coreExtensionData.routePath)).toBe('/assistant');
  });
});

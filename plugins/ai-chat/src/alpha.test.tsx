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

import {
  ApiBlueprint,
  coreExtensionData,
} from '@backstage/frontend-plugin-api';
import { createExtensionTester } from '@backstage/frontend-test-utils';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import type {
  AiChatReferenceSourcesApi,
  AiChatToolResultsApi,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import {
  AiChatReferenceSourceBlueprint,
  AiChatToolResultBlueprint,
} from '@kwkevinchan/backstage-plugin-ai-chat-react/alpha';
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

  it('adds the API of the chat backend and the side panel API', () => {
    expect(aiChatPlugin.getExtension('api:ai-chat')).toBeDefined();
    expect(aiChatPlugin.getExtension('api:ai-chat/panel')).toBeDefined();
    expect(aiChatPlugin.getExtension('api:ai-chat/tool-results')).toBeDefined();
    expect(
      aiChatPlugin.getExtension('api:ai-chat/reference-sources'),
    ).toBeDefined();
  });

  it('collects the sources of AiChatReferenceSourceBlueprint in order, the first one for an id wins', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const Docs = () => null;
    const Later = () => null;
    const Template = () => null;
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('api:ai-chat/reference-sources'),
    )
      .add(
        AiChatReferenceSourceBlueprint.make({
          name: 'docs',
          params: { id: 'docs-page', title: 'Documentation page', component: Docs },
        }),
      )
      .add(
        AiChatReferenceSourceBlueprint.make({
          name: 'later',
          params: { id: 'docs-page', title: 'Again', component: Later },
        }),
      )
      .add(
        AiChatReferenceSourceBlueprint.make({
          name: 'template',
          params: { id: 'template', title: 'Template', component: Template },
        }),
      );
    const factory = tester.get(ApiBlueprint.dataRefs.factory);
    const api = factory.factory({}) as AiChatReferenceSourcesApi;
    expect(api.getSources()).toEqual([
      { id: 'docs-page', title: 'Documentation page', component: Docs },
      { id: 'template', title: 'Template', component: Template },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('docs-page is registered already'),
    );
    warn.mockRestore();
  });

  it('collects the result components of AiChatToolResultBlueprint, the first one for an id wins', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const First = () => null;
    const Later = () => null;
    const Other = () => null;
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('api:ai-chat/tool-results'),
    )
      .add(
        AiChatToolResultBlueprint.make({
          name: 'first',
          params: { actionId: 'example:list', component: First },
        }),
      )
      .add(
        AiChatToolResultBlueprint.make({
          name: 'later',
          params: { actionId: 'example:list', component: Later },
        }),
      )
      .add(
        AiChatToolResultBlueprint.make({
          name: 'other',
          params: { actionId: 'example:other', component: Other },
        }),
      );
    const factory = tester.get(ApiBlueprint.dataRefs.factory);
    const api = factory.factory({}) as AiChatToolResultsApi;
    expect(api.getComponent('example:list')).toBe(First);
    expect(api.getComponent('example:other')).toBe(Other);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('example:list is registered already'),
    );
    warn.mockRestore();
  });

  it('mounts the side panel at the app root', () => {
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('app-root-element:ai-chat/panel'),
    );
    expect(tester.get(coreExtensionData.reactElement)).toBeTruthy();
  });

  it('adds the entity page AI chat tab', () => {
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('entity-content:ai-chat/entity-ai-chat'),
    );
    expect(tester.get(coreExtensionData.routePath)).toBe('/ai-chat');
    expect(tester.get(EntityContentBlueprint.dataRefs.title)).toBe('AI chat');
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

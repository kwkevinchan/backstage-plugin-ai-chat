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

/**
 * Entry point for the new frontend system: the plugin (default export), with
 * the chat page on `/ai-chat`, the API of the chat backend, the side panel
 * and its Utility API at the app root, and the result component API
 * (`api:ai-chat/tool-results`), which collects the extensions of
 * `AiChatToolResultBlueprint`. The page's title and icon make
 * the app list it in the sidebar. The panel stays mounted when the page
 * changes. The extensions are not exported by name; an app reaches them with
 * `getExtension()` and `withOverrides()` of the plugin.
 *
 * @packageDocumentation
 */

import {
  compatWrapper,
  convertLegacyRouteRef,
  convertLegacyRouteRefs,
} from '@backstage/core-compat-api';
import {
  ApiBlueprint,
  AppRootElementBlueprint,
  createExtensionInput,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import {
  aiChatPanelApiRef,
  aiChatToolResultsApiRef,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { AiChatToolResultBlueprint } from '@kwkevinchan/backstage-plugin-ai-chat-react/alpha';
import { RiChat3Line } from '@remixicon/react';
import { aiChatApiRef } from './api';
import { AiChatClient } from './adapters/AiChatClient';
import { createAiChatPanelStore } from './application/panelStore';
import { createAiChatToolResultsApi } from './application/toolResultsApi';
import { rootRouteRef } from './routes';
import { AiChatPanel } from './ui/AiChatPanel';

const aiChatApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: aiChatApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new AiChatClient({ discoveryApi, fetchApi }),
    }),
});

const aiChatPanelApi = ApiBlueprint.make({
  name: 'panel',
  params: defineParams =>
    defineParams({
      api: aiChatPanelApiRef,
      deps: {},
      factory: () => createAiChatPanelStore(),
    }),
});

/**
 * The result components of the plugins, in the order of the input: the first
 * one for an action id is used.
 */
const aiChatToolResultsApi = ApiBlueprint.makeWithOverrides({
  name: 'tool-results',
  inputs: {
    toolResults: createExtensionInput([
      AiChatToolResultBlueprint.dataRefs.toolResult,
    ]),
  },
  factory(originalFactory, { inputs }) {
    return originalFactory(defineParams =>
      defineParams({
        api: aiChatToolResultsApiRef,
        deps: {},
        factory: () =>
          createAiChatToolResultsApi(
            inputs.toolResults.map(input =>
              input.get(AiChatToolResultBlueprint.dataRefs.toolResult),
            ),
          ),
      }),
    );
  },
});

/**
 * The side panel, once, at the app root. A page change does not unmount it,
 * and the app does not render it again.
 */
const aiChatPanel = AppRootElementBlueprint.make({
  name: 'panel',
  params: { element: <AiChatPanel /> },
});

/** The chat page on `/ai-chat`. */
const aiChatPage = PageBlueprint.make({
  params: {
    path: '/ai-chat',
    title: 'AI chat',
    icon: <RiChat3Line size="1em" />,
    routeRef: convertLegacyRouteRef(rootRouteRef),
    loader: () =>
      import('./ui/ChatPage').then(m =>
        compatWrapper(<m.ChatPageInContainer />),
      ),
  },
});

/**
 * The AI chat plugin for the new frontend system.
 *
 * @alpha
 */
export default createFrontendPlugin({
  pluginId: 'ai-chat',
  extensions: [
    aiChatApi,
    aiChatPanelApi,
    aiChatToolResultsApi,
    aiChatPage,
    aiChatPanel,
  ],
  routes: convertLegacyRouteRefs({
    root: rootRouteRef,
  }),
});

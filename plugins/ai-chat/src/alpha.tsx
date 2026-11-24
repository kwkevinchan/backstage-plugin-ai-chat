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
 * the chat page on `/ai-chat` and the API of the chat backend. The page's
 * title and icon make the app list it in the sidebar. The extensions are not
 * exported by name; an app reaches them with `getExtension()` and
 * `withOverrides()` of the plugin.
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
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { RiChat3Line } from '@remixicon/react';
import { AiChatClient, aiChatApiRef } from './api';
import { rootRouteRef } from './routes';

const aiChatApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: aiChatApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new AiChatClient({ discoveryApi, fetchApi }),
    }),
});

/** The chat page on `/ai-chat`. */
const aiChatPage = PageBlueprint.make({
  params: {
    path: '/ai-chat',
    title: 'AI chat',
    icon: <RiChat3Line size="1em" />,
    routeRef: convertLegacyRouteRef(rootRouteRef),
    loader: () =>
      import('./components/ChatPage').then(m =>
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
  extensions: [aiChatApi, aiChatPage],
  routes: convertLegacyRouteRefs({
    root: rootRouteRef,
  }),
});

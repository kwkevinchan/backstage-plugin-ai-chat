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
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { AiChatClient, aiChatApiRef } from './api';
import { rootRouteRef } from './routes';

/**
 * The AI chat plugin for the legacy frontend system.
 *
 * @public
 */
export const aiChatPlugin = createPlugin({
  id: 'ai-chat',
  apis: [
    createApiFactory({
      api: aiChatApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new AiChatClient({ discoveryApi, fetchApi }),
    }),
  ],
  routes: {
    root: rootRouteRef,
  },
});

/**
 * The chat page: the conversations of the signed-in user, the open
 * conversation with its tool calls and approval cards, and the input box.
 * Mount it on a route such as `/ai-chat`.
 *
 * @public
 */
export const AiChatPage: () => JSX.Element = aiChatPlugin.provide(
  createRoutableExtension({
    name: 'AiChatPage',
    component: () =>
      import('./components/ChatPage').then(m => m.ChatPageWithHeader),
    mountPoint: rootRouteRef,
  }),
);

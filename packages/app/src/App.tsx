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

import { Navigate, Route } from 'react-router-dom';
import {
  CatalogEntityPage,
  CatalogIndexPage,
  EntityAboutCard,
  EntityLayout,
} from '@backstage/plugin-catalog';
import { UserSettingsPage } from '@backstage/plugin-user-settings';
import {
  AlertDisplay,
  OAuthRequestDialog,
  SignInPage,
} from '@backstage/core-components';
import { createApp } from '@backstage/app-defaults';
import { AppRouter, FlatRoutes } from '@backstage/core-app-api';
import { createApiFactory } from '@backstage/core-plugin-api';
import {
  AiChatPage,
  AiChatPanel,
  aiChatPlugin,
  createAiChatReferenceSourcesApi,
  createAiChatToolResultsApi,
  EntityAiChatContent,
} from '@kwkevinchan/backstage-plugin-ai-chat';
import {
  aiChatReferenceSourcesApiRef,
  aiChatToolResultsApiRef,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { exampleSnippetsSource } from './components/aiChat/exampleSnippetsSource';
import { listServicesResult } from './components/aiChat/listServicesResult';
import { RunbookCard } from './components/aiChat/RunbookCard';
import { Root } from './components/Root';

const app = createApp({
  plugins: [aiChatPlugin],
  apis: [
    // The result components of the chat, first one for an action id wins.
    createApiFactory({
      api: aiChatToolResultsApiRef,
      deps: {},
      factory: () => createAiChatToolResultsApi([listServicesResult]),
    }),
    // The sources of the "Add reference" menu of the chat.
    createApiFactory({
      api: aiChatReferenceSourcesApiRef,
      deps: {},
      factory: () => createAiChatReferenceSourcesApi([exampleSnippetsSource]),
    }),
  ],
  components: {
    SignInPage: props => <SignInPage {...props} providers={['guest']} />,
  },
});

const entityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <>
        <EntityAboutCard />
        <RunbookCard />
      </>
    </EntityLayout.Route>
    <EntityLayout.Route path="/ai-chat" title="AI chat">
      <EntityAiChatContent />
    </EntityLayout.Route>
  </EntityLayout>
);

const routes = (
  <FlatRoutes>
    <Route path="/" element={<Navigate to="ai-chat" />} />
    <Route path="/catalog" element={<CatalogIndexPage />} />
    <Route
      path="/catalog/:namespace/:kind/:name"
      element={<CatalogEntityPage />}
    >
      {entityPage}
    </Route>
    <Route path="/ai-chat" element={<AiChatPage />} />
    <Route path="/settings" element={<UserSettingsPage />} />
  </FlatRoutes>
);

export default app.createRoot(
  <>
    <AlertDisplay />
    <OAuthRequestDialog />
    <AppRouter>
      {/* Outside the routes: the conversation stays mounted when the page changes. */}
      <AiChatPanel />
      <Root>{routes}</Root>
    </AppRouter>
  </>,
);

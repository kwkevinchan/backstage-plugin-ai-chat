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
import { CatalogIndexPage } from '@backstage/plugin-catalog';
import { UserSettingsPage } from '@backstage/plugin-user-settings';
import {
  AlertDisplay,
  OAuthRequestDialog,
  SignInPage,
} from '@backstage/core-components';
import { createApp } from '@backstage/app-defaults';
import { AppRouter, FlatRoutes } from '@backstage/core-app-api';
import {
  AiChatPage,
  AiChatPanel,
  aiChatPlugin,
} from '@kwkevinchan/backstage-plugin-ai-chat';
import { Root } from './components/Root';

const app = createApp({
  plugins: [aiChatPlugin],
  components: {
    SignInPage: props => <SignInPage {...props} providers={['guest']} />,
  },
});

const routes = (
  <FlatRoutes>
    <Route path="/" element={<Navigate to="ai-chat" />} />
    <Route path="/catalog" element={<CatalogIndexPage />} />
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

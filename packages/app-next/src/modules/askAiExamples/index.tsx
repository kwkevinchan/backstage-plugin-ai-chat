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

import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { AiChatReferenceSourceBlueprint } from '@kwkevinchan/backstage-plugin-ai-chat-react/alpha';
import { exampleSnippetsSource } from './exampleSnippetsSource';

/**
 * The examples of asking the chat from a page: a card on the entity page with
 * text to select and a button that asks about the entity, and a source of
 * references for the "Add reference" menu of the chat.
 */
export const askAiExamplesPlugin = createFrontendPlugin({
  pluginId: 'ask-ai-examples',
  extensions: [
    EntityCardBlueprint.make({
      name: 'runbook',
      params: {
        loader: () => import('./RunbookCard').then(m => <m.RunbookCard />),
      },
    }),
    AiChatReferenceSourceBlueprint.make({
      name: 'example-snippets',
      params: exampleSnippetsSource,
    }),
  ],
});

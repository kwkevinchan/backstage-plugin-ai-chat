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

import { createExtensionPoint } from '@backstage/backend-plugin-api';
import type { AiChatHarnessExtensionPoint } from '@kwkevinchan/ai-chat-harness';

/**
 * The extension point a backend module uses to add an agent (X-02). The
 * backend plugin registers the implementation. A module depends only on this
 * package. Further methods are added on later items.
 *
 * @public
 */
export const aiChatHarnessExtensionPoint =
  createExtensionPoint<AiChatHarnessExtensionPoint>({
    id: 'ai-chat.harness',
  });

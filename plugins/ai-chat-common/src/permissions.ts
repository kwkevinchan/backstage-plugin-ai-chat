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

import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Whether the caller may read one session. The resource is the session id.
 * The backend allows the owner, and someone a share names, and refuses
 * everyone else. A policy can replace that with its own conditions.
 *
 * @public
 */
export const aiChatSessionReadPermission = createPermission({
  name: 'ai-chat.session.read',
  attributes: { action: 'read' },
  resourceType: 'ai-chat-session',
});

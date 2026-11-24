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

import { useEffect, useState } from 'react';
import type { ChatTool } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';

/**
 * The tools of a session by id, to show its calls with a title, a description
 * and whether they change anything. `refreshKey` reads them again (the
 * toolsets changed). A call whose tool is not listed is shown by its id.
 */
export function useSessionTools(
  api: AiChatApi,
  sessionId: string,
  refreshKey?: string,
): Record<string, ChatTool> {
  const [tools, setTools] = useState<Record<string, ChatTool>>({});
  useEffect(() => {
    let cancelled = false;
    api
      .listSessionTools(sessionId)
      .then(list => {
        if (!cancelled) setTools(Object.fromEntries(list.map(t => [t.id, t])));
      })
      .catch(() => {
        // The calls are shown without the details.
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, refreshKey]);
  return tools;
}

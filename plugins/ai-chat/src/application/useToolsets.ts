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
import type { ChatToolset } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';

/** The toolsets that a session can switch on or off (T-11). */
export function useToolsets(api: AiChatApi): ChatToolset[] {
  const [toolsets, setToolsets] = useState<ChatToolset[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listToolsets()
      .then(list => {
        if (!cancelled) setToolsets(list);
      })
      .catch(() => {
        // The chat works without the list; the switches are not shown.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  return toolsets;
}

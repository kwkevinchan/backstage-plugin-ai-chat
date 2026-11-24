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

import { useCallback, useEffect, useState } from 'react';
import type { ChatSession } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import { describeError } from '../adapters/describeError';

/** The sessions of the user, the most recently changed first. */
export function useSessionList(api: AiChatApi) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
      setError(undefined);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await api.deleteSession(id);
        await refresh();
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      }
    },
    [api, refresh],
  );

  return { sessions, error, refresh, remove };
}

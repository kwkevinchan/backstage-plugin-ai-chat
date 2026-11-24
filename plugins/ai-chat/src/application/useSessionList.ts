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

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatSession,
  UpdateChatSessionRequest,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import { describeError } from '../adapters/describeError';

/**
 * The sessions of the user. Pinned ones come first, then the most recently
 * changed. `query` searches the stored title. Archived sessions stay out
 * until `includeArchived` is set (SE-03).
 */
export function useSessionList(api: AiChatApi) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const trimmed = query.trim();
    const options =
      trimmed || includeArchived
        ? {
            ...(trimmed && { query: trimmed }),
            ...(includeArchived && { includeArchived: true }),
          }
        : undefined;
    try {
      const next = options
        ? await api.listSessions(options)
        : await api.listSessions();
      if (mine !== generation.current) return;
      setSessions(next);
      setError(undefined);
    } catch (e) {
      if (mine !== generation.current) return;
      setError(describeError(e));
    }
  }, [api, query, includeArchived]);

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

  const change = useCallback(
    async (id: string, patch: UpdateChatSessionRequest): Promise<boolean> => {
      try {
        await api.updateSession(id, patch);
        await refresh();
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      }
    },
    [api, refresh],
  );

  return {
    sessions,
    error,
    query,
    setQuery,
    includeArchived,
    setIncludeArchived,
    refresh,
    remove,
    change,
  };
}

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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { signalApiRef } from '@backstage/plugin-signals-react';
import type { JsonObject } from '@backstage/types';
import type { ChatSession } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { describeError } from '../adapters/describeError';

/** How often the list is read when Signals is not installed. Same as the item poll. */
export const ACTIVITY_POLL_MS = 1000;

/** The Signals channel the backend publishes on. */
export const AI_CHAT_SIGNAL_CHANNEL = 'ai-chat';

/** What a signal on {@link AI_CHAT_SIGNAL_CHANNEL} carries. */
export type ActivityMessage = JsonObject & {
  sessionId: string;
  activity: string;
};

/** A session in the list, plus a New reply mark that lives in this tab only. */
export type SessionListEntry = ChatSession & { newReply?: boolean };

/**
 * The list of sessions, kept up to date (B-05).
 *
 * With `subscribe` (Signals is installed) a message refreshes the list and
 * the hook does not poll. Without it the list is read once a second.
 *
 * New reply: a session that is not the open one, that was `running` or
 * `waiting_approval`, and that no longer has an active run. Opening it
 * clears the mark. The mark is not stored.
 */
export function useSessionActivity(options: {
  listSessions: () => Promise<ChatSession[]>;
  subscribe?: (onMessage: (message: ActivityMessage) => void) => () => void;
  openSessionId?: string;
  intervalMs?: number;
}): {
  sessions: SessionListEntry[];
  error?: string;
  refresh: () => Promise<void>;
} {
  const { listSessions, subscribe, openSessionId, intervalMs } = options;
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [error, setError] = useState<string>();
  const previous = useRef(new Map<string, ChatSession['activity']>());
  const replies = useRef(new Set<string>());
  const openRef = useRef(openSessionId);
  openRef.current = openSessionId;

  const apply = useCallback((list: ChatSession[]): SessionListEntry[] => {
    const open = openRef.current;
    const nextPrevious = new Map<string, ChatSession['activity']>();
    for (const session of list) {
      const before = previous.current.get(session.id);
      if (
        session.id !== open &&
        (before === 'running' || before === 'waiting_approval') &&
        !session.activity
      ) {
        replies.current.add(session.id);
      }
      if (session.id === open || session.activity) {
        replies.current.delete(session.id);
      }
      nextPrevious.set(session.id, session.activity);
    }
    previous.current = nextPrevious;
    return list.map(session =>
      replies.current.has(session.id)
        ? { ...session, newReply: true }
        : session,
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSessions(apply(await listSessions()));
      setError(undefined);
    } catch (e) {
      setError(describeError(e));
    }
  }, [apply, listSessions]);

  useEffect(() => {
    if (!openSessionId) return;
    replies.current.delete(openSessionId);
    setSessions(current =>
      current.map(session =>
        session.id === openSessionId
          ? { ...session, newReply: undefined }
          : session,
      ),
    );
  }, [openSessionId]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const list = await listSessions();
        if (cancelled) return;
        setSessions(apply(list));
        setError(undefined);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    };
    void pull();
    if (subscribe) {
      const stop = subscribe(() => {
        void pull();
      });
      return () => {
        cancelled = true;
        stop();
      };
    }
    const timer = setInterval(() => {
      void pull();
    }, intervalMs ?? ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apply, intervalMs, listSessions, subscribe]);

  return { sessions, error, refresh };
}

/**
 * A subscribe function when the Signals API is registered, otherwise
 * `undefined` (the list is polled). `useSignal` throws when the API is
 * missing, so this reads the holder instead.
 */
export function useSignalsActivitySubscribe():
  | ((onMessage: (message: ActivityMessage) => void) => () => void)
  | undefined {
  const api = useApiHolder().get(signalApiRef);
  return useMemo(() => {
    if (!api) return undefined;
    return (onMessage: (message: ActivityMessage) => void) => {
      const subscription = api.subscribe<ActivityMessage>(
        AI_CHAT_SIGNAL_CHANNEL,
        onMessage,
      );
      return () => subscription.unsubscribe();
    };
  }, [api]);
}

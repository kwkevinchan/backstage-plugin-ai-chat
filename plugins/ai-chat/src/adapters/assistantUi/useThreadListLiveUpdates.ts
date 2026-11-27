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
import { useAui, useAuiState } from '@assistant-ui/react';
import { useApiHolder } from '@backstage/core-plugin-api';
import {
  AI_CHAT_SIGNAL_CHANNEL,
  parseSessionActivitySignal,
  signalApiRef,
  type SessionSignalActivity,
} from '../signals';
import {
  readThreadCustom,
  type SessionListActivity,
} from './threadListAdapter';

const ACTIVE_POLL_MS = 3_000;
const FALLBACK_POLL_MS = 15_000;
const TITLE_FOLLOWUP_POLL_MS = 2_000;

/**
 * Keeps the thread list of the surrounding `AssistantRuntimeProvider` fresh:
 * Backstage Signals when the app has it, polling that pauses while the tab
 * is hidden, and the "New reply" mark of sessions that finish in the
 * background. `openId` is the session shown next to the list; it gets no
 * "New reply" mark. Pass an empty string when no session is open.
 */
export function useThreadListLiveUpdates(openId: string): {
  signalActivities: Record<string, SessionSignalActivity>;
  reloadList(): void;
} {
  const aui = useAui();
  const apiHolder = useApiHolder();
  const signals = apiHolder.get(signalApiRef);
  const threadItems = useAuiState(s => s.threads.threadItems);
  const [signalActivities, setSignalActivities] = useState<
    Record<string, SessionSignalActivity>
  >({});
  const signalSeqRef = useRef(0);
  const signalVersionsRef = useRef<Record<string, number>>({});
  const prevActivitiesRef = useRef<Map<string, SessionListActivity>>(new Map());
  const openIdRef = useRef(openId);
  openIdRef.current = openId;

  const hasActiveSession = useMemo(
    () =>
      threadItems.some(
        item => readThreadCustom(item.custom).activity !== undefined,
      ),
    [threadItems],
  );

  // When Backstage Signals is not installed and a non-open session transitions
  // from active (running / waiting) to idle across a list refresh, mark it
  // "replied" so "New reply" still appears. Known limitation without Signals:
  // failed, cancelled, and expired runs also transition from active to idle.
  useEffect(() => {
    if (signals) return;
    const prev = prevActivitiesRef.current;
    const next = new Map<string, SessionListActivity>();
    const newlyCompleted: string[] = [];
    for (const item of threadItems) {
      const id = item.remoteId ?? item.id;
      const activity = readThreadCustom(item.custom).activity;
      if (activity !== undefined) {
        next.set(id, activity);
      } else if (prev.has(id) && id !== openIdRef.current) {
        newlyCompleted.push(id);
      }
    }
    prevActivitiesRef.current = next;
    if (newlyCompleted.length > 0) {
      setSignalActivities(current => {
        let changed = false;
        const updated = { ...current };
        for (const id of newlyCompleted) {
          if (updated[id] !== 'idle' && updated[id] !== 'replied') {
            updated[id] = 'replied';
            changed = true;
          }
        }
        return changed ? updated : current;
      });
    }
  }, [signals, threadItems]);

  const reloadList = useCallback(() => {
    const seqAtStart = signalSeqRef.current;
    void aui.threads.reload().then(() => {
      setSignalActivities(current => {
        const next: Record<string, SessionSignalActivity> = {};
        let changed = false;
        for (const [id, activity] of Object.entries(current)) {
          const version = signalVersionsRef.current[id] ?? 0;
          if (activity === 'replied' || version > seqAtStart) {
            next[id] = activity;
          } else {
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
  }, [aui]);

  // Clear the "New reply" badge once the user opens that conversation.
  useEffect(() => {
    if (!openId) return;
    setSignalActivities(current => {
      if (current[openId] !== 'replied') return current;
      const { [openId]: _cleared, ...rest } = current;
      return rest;
    });
  }, [openId]);

  // Subscribe to Backstage Signals when available for immediate status updates.
  useEffect(() => {
    if (!signals) return undefined;
    const followupTimers = new Set<ReturnType<typeof setTimeout>>();
    const subscription = signals.subscribe(AI_CHAT_SIGNAL_CHANNEL, message => {
      const event = parseSessionActivitySignal(message);
      if (!event) return;
      signalSeqRef.current += 1;
      signalVersionsRef.current[event.sessionId] = signalSeqRef.current;
      setSignalActivities(current => {
        if (
          event.activity === 'replied' &&
          event.sessionId === openIdRef.current
        ) {
          if (!(event.sessionId in current)) return current;
          const { [event.sessionId]: _cleared, ...rest } = current;
          return rest;
        }
        return { ...current, [event.sessionId]: event.activity };
      });
      if (event.activity === 'replied' || event.activity === 'idle') {
        reloadList();
      }
      if (event.activity === 'replied') {
        // Auto-title is written after the replied notification; follow up once
        // so the generated title appears without waiting for the next poll.
        const timer = setTimeout(() => {
          followupTimers.delete(timer);
          reloadList();
        }, TITLE_FOLLOWUP_POLL_MS);
        followupTimers.add(timer);
      }
    });
    return () => {
      subscription.unsubscribe();
      followupTimers.forEach(timer => clearTimeout(timer));
    };
  }, [signals, reloadList]);

  // Always keep low-frequency fallback polling even when Signals is present,
  // paused while the tab is hidden. Without Signals, poll faster while any
  // session is actively running so Processing / New reply stays fresh.
  const pollIntervalMs =
    !signals && hasActiveSession ? ACTIVE_POLL_MS : FALLBACK_POLL_MS;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (document.visibilityState !== 'hidden') {
          reloadList();
        }
      }, pollIntervalMs);
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        reloadList();
        start();
      }
    };
    if (document.visibilityState !== 'hidden') {
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reloadList, pollIntervalMs]);

  return { signalActivities, reloadList };
}

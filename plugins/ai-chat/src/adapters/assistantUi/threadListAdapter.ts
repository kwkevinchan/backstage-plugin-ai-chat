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

import type { RemoteThreadListAdapter } from '@assistant-ui/react';
import type { ChatSession } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../../api';

type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter['fetch']>
>;

/** Activity state carried on a session list item. */
export type SessionListActivity = NonNullable<ChatSession['activity']>;

/** Custom metadata carried on each thread list item. */
export type ThreadListCustom = {
  pinned: boolean;
  activity?: SessionListActivity;
};

/** Options for {@link createThreadListAdapter}. */
export interface ThreadListAdapterOptions {
  api: AiChatApi;
  /** Optional title substring filter sent to `GET /sessions`. */
  query?: string;
  /** When true, archived sessions are included in `GET /sessions`. */
  includeArchived?: boolean;
  /** Called right before a mutating action starts (to clear stale errors). */
  onActionStart?(): void;
  /** Called after a mutating action succeeds. */
  onActionSuccess?(): void;
  /** Called when a mutating action fails before the error is rethrown. */
  onActionError?(error: unknown): void;
  /** Polling interval in ms while waiting for the backend-generated title. */
  generateTitlePollMs?: number;
  /** Maximum time in ms to wait for the backend-generated title. */
  generateTitleTimeoutMs?: number;
}

const DEFAULT_TITLE_POLL_MS = 500;
const DEFAULT_TITLE_TIMEOUT_MS = 10_000;

/** Extracts typed custom fields from a `RemoteThreadMetadata.custom` record. */
export function readThreadCustom(
  custom: Record<string, unknown> | undefined,
): ThreadListCustom {
  const pinned = Boolean(custom?.pinned);
  const rawActivity = custom?.activity;
  const activity: SessionListActivity | undefined =
    rawActivity === 'running' || rawActivity === 'waiting_approval'
      ? rawActivity
      : undefined;
  return activity ? { pinned, activity } : { pinned };
}

/** Converts a backend `ChatSession` into assistant-ui's `RemoteThreadMetadata`. */
export function toRemoteThreadMetadata(
  session: ChatSession,
): RemoteThreadMetadata {
  const custom: ThreadListCustom = {
    pinned: session.pinned,
    ...(session.activity && { activity: session.activity }),
  };
  return {
    status: session.archivedAt ? 'archived' : 'regular',
    remoteId: session.id,
    title: session.title,
    lastMessageAt: new Date(session.updatedAt),
    custom,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const handle: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => {
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      resolve();
    };
    handle.timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type TitleStream = Awaited<
  ReturnType<RemoteThreadListAdapter['generateTitle']>
>;

/**
 * Waits for the backend's asynchronous title generation without calling a
 * model from the browser. Emits the title text once it appears, or closes
 * cleanly when the timeout elapses.
 */
function createTitlePollingStream(
  api: AiChatApi,
  remoteId: string,
  pollMs: number,
  timeoutMs: number,
): TitleStream {
  const abort = new AbortController();
  return new ReadableStream({
    async start(controller) {
      const deadline = Date.now() + timeoutMs;
      try {
        while (!abort.signal.aborted) {
          try {
            const detail = await api.getSession(remoteId);
            if (abort.signal.aborted) break;
            const title = detail.session.title?.trim();
            if (title) {
              controller.enqueue({
                type: 'part-start',
                path: [0],
                part: { type: 'text' },
              } as never);
              controller.enqueue({
                type: 'text-delta',
                path: [0],
                textDelta: title,
              } as never);
              controller.enqueue({
                type: 'part-finish',
                path: [0],
              } as never);
              break;
            }
          } catch {
            // Keep polling until the deadline; the session may still be settling.
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await wait(Math.min(pollMs, remaining), abort.signal);
        }
      } finally {
        if (!abort.signal.aborted) {
          controller.close();
        }
      }
    },
    cancel() {
      abort.abort();
    },
  }) as TitleStream;
}

/**
 * Bridges `AiChatApi` to assistant-ui's `RemoteThreadListAdapter`.
 */
export function createThreadListAdapter(
  options: ThreadListAdapterOptions,
): RemoteThreadListAdapter {
  const {
    api,
    query,
    includeArchived = false,
    onActionStart,
    onActionSuccess,
    onActionError,
    generateTitlePollMs = DEFAULT_TITLE_POLL_MS,
    generateTitleTimeoutMs = DEFAULT_TITLE_TIMEOUT_MS,
  } = options;
  const trimmedQuery = query?.trim() || undefined;

  async function runMutation<T>(fn: () => Promise<T>): Promise<T> {
    onActionStart?.();
    try {
      const result = await fn();
      onActionSuccess?.();
      return result;
    } catch (error) {
      onActionError?.(error);
      throw error;
    }
  }

  return {
    storeKey: `ai-chat:${trimmedQuery ?? ''}:${includeArchived ? '1' : '0'}`,

    async list() {
      const sessions = await api.listSessions({
        ...(trimmedQuery && { query: trimmedQuery }),
        ...(includeArchived && { includeArchived: true }),
      });
      return {
        threads: sessions.map(toRemoteThreadMetadata),
      };
    },

    async fetch(threadId) {
      const detail = await api.getSession(threadId);
      return toRemoteThreadMetadata(detail.session);
    },

    async initialize(_threadId, initOptions) {
      const rawToolsets = initOptions?.custom?.enabledToolsets;
      const enabledToolsets = Array.isArray(rawToolsets)
        ? rawToolsets.filter((id): id is string => typeof id === 'string')
        : undefined;
      const session = await api.createSession(
        enabledToolsets ? { enabledToolsets } : {},
      );
      return { remoteId: session.id };
    },

    async rename(remoteId, newTitle) {
      await runMutation(() => api.updateSession(remoteId, { title: newTitle }));
    },

    async archive(remoteId) {
      await runMutation(() => api.updateSession(remoteId, { archived: true }));
    },

    async unarchive(remoteId) {
      await runMutation(() => api.updateSession(remoteId, { archived: false }));
    },

    async delete(remoteId) {
      await runMutation(() => api.deleteSession(remoteId));
    },

    async updateCustom(remoteId, custom) {
      const pinned = Boolean(custom?.pinned);
      await runMutation(() => api.updateSession(remoteId, { pinned }));
    },

    async generateTitle(remoteId) {
      return createTitlePollingStream(
        api,
        remoteId,
        generateTitlePollMs,
        generateTitleTimeoutMs,
      );
    },
  };
}

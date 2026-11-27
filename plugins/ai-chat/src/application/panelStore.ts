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

import type {
  AiChatLaunchRequest,
  AiChatPanelApi,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import {
  applyClose,
  applyLaunch,
  applyOpen,
  applySession,
  initialPanelState,
  type PanelState,
} from '../domain/panel';
import {
  createSendContentsStore,
  type SendContentsStore,
} from './sendContents';

/**
 * The internal panel state and one-shot launch coordination backing an
 * {@link AiChatPanelApi} instance.
 */
export interface AiChatPanelStore {
  /** The current state. The same object until something changes. */
  getSnapshot(): PanelState;
  /** Calls `listener` after a change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * The box of the panel: the references that `open()` and the user added,
   * and the page switch. It stays while the panel is closed.
   */
  contents: SendContentsStore;
  /** Remembers or forgets the conversation on the panel. */
  setSession(sessionId: string | undefined): void;
  /**
   * Runs `task` once for this launch. A second call with the same id,
   * including one from a component that remounted, receives the same promise.
   * A task that fails is forgotten, so a later call can try again.
   */
  start<T>(launchId: number, task: () => Promise<T>): Promise<T>;
}

const stores = new WeakMap<AiChatPanelApi, AiChatPanelStore>();

/**
 * Creates one independent panel Utility API instance and associates its
 * internal store so the panel UI can coordinate sessions and launches.
 */
export function createAiChatPanelStore(): AiChatPanelApi {
  let state = initialPanelState();
  const storeListeners = new Set<() => void>();
  const openListeners = new Set<() => void>();
  const started = new Map<number, Promise<unknown>>();
  const contents = createSendContentsStore();

  const commit = (next: PanelState) => {
    if (next === state) return;
    const openChanged = next.open !== state.open;
    state = next;
    for (const listener of storeListeners) listener();
    if (openChanged) {
      for (const listener of openListeners) listener();
    }
  };

  const subscribeStore = (listener: () => void) => {
    storeListeners.add(listener);
    return () => {
      storeListeners.delete(listener);
    };
  };

  const subscribeOpen = (listener: () => void) => {
    openListeners.add(listener);
    return () => {
      openListeners.delete(listener);
    };
  };

  const api: AiChatPanelApi = {
    isOpen: () => state.open,
    open(request?: AiChatLaunchRequest) {
      if (Array.isArray(request?.references)) {
        contents.add(request.references);
      }
      if (
        request !== undefined &&
        (request.prompt !== undefined || request.entityRef !== undefined)
      ) {
        commit(applyLaunch(state, request));
      } else {
        commit(applyOpen(state));
      }
    },
    close() {
      commit(applyClose(state));
    },
    subscribe: subscribeOpen,
  };

  const store: AiChatPanelStore = {
    getSnapshot: () => state,
    subscribe: subscribeStore,
    contents,
    setSession(sessionId) {
      commit(applySession(state, sessionId));
    },
    start<T>(launchId: number, task: () => Promise<T>): Promise<T> {
      const existing = started.get(launchId);
      if (existing) return existing as Promise<T>;
      const promise = task().catch(error => {
        started.delete(launchId);
        throw error;
      });
      // Stored before the first await, so a remount that runs at once shares it.
      started.set(launchId, promise);
      return promise;
    },
  };

  stores.set(api, store);
  return api;
}

/**
 * Returns the internal store backing `api`. Throws when `api` was not created
 * by {@link createAiChatPanelStore}.
 */
export function getAiChatPanelStore(api: AiChatPanelApi): AiChatPanelStore {
  const store = stores.get(api);
  if (!store) {
    throw new Error(
      'aiChatPanelApiRef must be implemented by createAiChatPanelStore()',
    );
  }
  return store;
}

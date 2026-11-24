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

import type { AiChatLaunchRequest } from '../domain/launch';
import {
  applyClose,
  applyLaunch,
  applyOpen,
  applySession,
  initialPanelState,
  type PanelState,
} from '../domain/panel';

/**
 * The panel state, and the one-shot start of a launch. `getSnapshot` returns
 * the same object until the state changes.
 *
 * @public
 */
export interface AiChatPanelStore {
  /** The current state. The same object until something changes. */
  getSnapshot(): PanelState;
  /** Calls `listener` after a change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Opens the panel without a launch. */
  reveal(): void;
  /** Opens the panel for a launch. */
  launch(request: AiChatLaunchRequest): void;
  /** Closes the panel. */
  close(): void;
  /** Remembers or forgets the conversation on the panel. */
  setSession(sessionId: string | undefined): void;
  /**
   * Runs `task` once for this launch. A second call with the same id,
   * including one from a component that remounted, receives the same promise.
   * A task that fails is forgotten, so a later call can try again.
   */
  start<T>(launchId: number, task: () => Promise<T>): Promise<T>;
}

interface ResettableStore {
  store: AiChatPanelStore;
  reset(): void;
}

function createStore(): ResettableStore {
  let state = initialPanelState();
  const listeners = new Set<() => void>();
  const started = new Map<number, Promise<unknown>>();

  const commit = (next: PanelState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const store: AiChatPanelStore = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reveal() {
      commit(applyOpen(state));
    },
    launch(request) {
      commit(applyLaunch(state, request));
    },
    close() {
      commit(applyClose(state));
    },
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

  return {
    store,
    reset() {
      started.clear();
      state = initialPanelState();
      for (const listener of listeners) listener();
    },
  };
}

const shared = createStore();

/** A new, independent panel state. @public */
export function createAiChatPanelStore(): AiChatPanelStore {
  return createStore().store;
}

/** The panel state used when no provider is rendered. */
export function getDefaultAiChatPanelStore(): AiChatPanelStore {
  return shared.store;
}

/**
 * Puts the shared panel state back to closed and empty, including a launch
 * that was not closed. Tests use it so one case does not leak into the next.
 *
 * @internal
 */
export function resetDefaultAiChatPanelStore(): void {
  shared.reset();
}

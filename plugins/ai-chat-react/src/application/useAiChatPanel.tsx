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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AiChatLaunchRequest, LaunchContext } from '../domain/launch';
import {
  createAiChatPanelStore,
  getDefaultAiChatPanelStore,
  type AiChatPanelStore,
} from './panelStore';

const PanelStoreContext = createContext<AiChatPanelStore | undefined>(
  undefined,
);

/**
 * Shares one panel state. Without it, {@link useAiChatPanel} uses the
 * package's default state, so a launcher on a page and the panel mounted at
 * the app root see the same conversation.
 *
 * @public
 */
export function AiChatPanelProvider(props: {
  store?: AiChatPanelStore;
  children: ReactNode;
}) {
  const store = useMemo(
    () => props.store ?? createAiChatPanelStore(),
    [props.store],
  );
  return (
    <PanelStoreContext.Provider value={store}>
      {props.children}
    </PanelStoreContext.Provider>
  );
}

/** The store the hook is reading. The chat panel uses it to start a launch once. @public */
export function useAiChatPanelStore(): AiChatPanelStore {
  return useContext(PanelStoreContext) ?? getDefaultAiChatPanelStore();
}

/**
 * The side panel as another plugin sees it: whether it is open, the launch
 * it is carrying, and the conversation it is showing.
 *
 * @public
 */
export interface AiChatPanelController {
  /** Whether the panel is open. */
  isOpen: boolean;
  /**
   * Opens the panel. A request that sets `prompt` or `entityRef` is a launch:
   * a prompt starts a new conversation, and an entity reference stays with
   * the messages. With neither field, the panel opens and the conversation
   * and the previous launch stay.
   */
  open(request?: AiChatLaunchRequest): void;
  /** Closes the panel. The conversation and the launch stay. */
  close(): void;
  /** The conversation on the panel, once one has been started. */
  readonly sessionId: string | undefined;
  /** What the last launch carried. */
  readonly launch: LaunchContext | undefined;
  /** Increases on every launch, so the same prompt starts a new conversation. */
  readonly launchId: number;
  /** Remembers the conversation the panel started. The chat plugin calls this. */
  setSession(sessionId: string | undefined): void;
  /**
   * Runs `task` once for this launch. The chat panel uses it so a prompt
   * creates one session even when the component remounts.
   */
  start<T>(launchId: number, task: () => Promise<T>): Promise<T>;
}

/**
 * The side panel. A page and the panel mounted at the app root share it,
 * because the new frontend system does not put them in one React context.
 *
 * @public
 */
export function useAiChatPanel(): AiChatPanelController {
  const store = useAiChatPanelStore();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const open = useCallback(
    (request?: AiChatLaunchRequest) => {
      if (
        request !== undefined &&
        (request.prompt !== undefined || request.entityRef !== undefined)
      ) {
        store.launch(request);
      } else {
        store.reveal();
      }
    },
    [store],
  );
  const close = useCallback(() => store.close(), [store]);
  const setSession = useCallback(
    (sessionId: string | undefined) => store.setSession(sessionId),
    [store],
  );
  const start = useCallback(
    <T,>(launchId: number, task: () => Promise<T>) =>
      store.start(launchId, task),
    [store],
  );
  return {
    isOpen: state.open,
    open,
    close,
    sessionId: state.sessionId,
    launch: state.launch,
    launchId: state.launchId,
    setSession,
    start,
  };
}

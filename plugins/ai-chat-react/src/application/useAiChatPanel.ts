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

import { useCallback, useSyncExternalStore } from 'react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { aiChatPanelApiRef, type AiChatLaunchRequest } from '../api';

const noop = () => {};
const noopSubscribe = () => noop;
const getClosed = () => false;

/**
 * Opens, closes, and reads whether the AI chat side panel is open.
 * When the chat plugin is not installed, `isOpen` stays `false` and `open`
 * and `close` do nothing.
 *
 * @public
 */
export function useAiChatPanel(): {
  isOpen: boolean;
  open: (request?: AiChatLaunchRequest) => void;
  close: () => void;
} {
  const api = useApiHolder().get(aiChatPanelApiRef);
  const subscribe = useCallback(
    (listener: () => void) => (api ? api.subscribe(listener) : noopSubscribe()),
    [api],
  );
  const getSnapshot = useCallback(
    () => (api ? api.isOpen() : getClosed()),
    [api],
  );
  const isOpen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const open = useCallback(
    (request?: AiChatLaunchRequest) => {
      api?.open(request);
    },
    [api],
  );
  const close = useCallback(() => {
    api?.close();
  }, [api]);
  return { isOpen, open, close };
}

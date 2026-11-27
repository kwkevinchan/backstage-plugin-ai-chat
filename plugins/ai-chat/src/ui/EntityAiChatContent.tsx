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
import { useNavigate } from 'react-router-dom';
import {
  AssistantRuntimeProvider,
  useAui,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type ThreadMessage,
} from '@assistant-ui/react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { useApi, useApiHolder, useRouteRef } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { aiChatApiRef } from '../api';
import { createThreadListAdapter } from '../adapters/assistantUi/threadListAdapter';
import { describeError } from '../adapters/describeError';
import {
  AI_CHAT_SIGNAL_CHANNEL,
  parseSessionActivitySignal,
  signalApiRef,
  type SessionSignalActivity,
} from '../adapters/signals';
import { rootRouteRef } from '../routes';
import { cx } from './styles';
import { ThreadListSidebar } from './ThreadListSidebar';

const SEARCH_DEBOUNCE_MS = 250;
const FALLBACK_POLL_MS = 15_000;
const EMPTY_MESSAGES: readonly ThreadMessage[] = [];
const NOOP_ON_NEW = async () => {};

function usePlaceholderThreadRuntime() {
  return useExternalStoreRuntime({
    messages: EMPTY_MESSAGES,
    onNew: NOOP_ON_NEW,
  });
}

function EntityThreadListBody({
  entityRef,
  chatBasePath,
  search,
  onSearchChange,
  showArchived,
  onShowArchivedChange,
  actionError,
  onClearError,
  onActionError,
  reloadRef,
}: {
  entityRef: string;
  chatBasePath: string;
  search: string;
  onSearchChange(value: string): void;
  showArchived: boolean;
  onShowArchivedChange(value: boolean): void;
  actionError?: string;
  onClearError(): void;
  onActionError(error: unknown): void;
  reloadRef: React.MutableRefObject<(() => void) | undefined>;
}) {
  const api = useApi(aiChatApiRef);
  const apiHolder = useApiHolder();
  const navigate = useNavigate();
  const aui = useAui();
  const [signalActivities, setSignalActivities] = useState<
    Record<string, SessionSignalActivity>
  >({});

  const reload = useCallback(() => {
    void aui.threads.reload();
  }, [aui]);

  useEffect(() => {
    reloadRef.current = reload;
    return () => {
      reloadRef.current = undefined;
    };
  }, [reload, reloadRef]);

  useEffect(() => {
    const signals = apiHolder.get(signalApiRef);
    if (!signals) {
      const timer = setInterval(() => {
        if (
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden'
        ) {
          return;
        }
        reload();
      }, FALLBACK_POLL_MS);
      return () => clearInterval(timer);
    }
    const { unsubscribe } = signals.subscribe(AI_CHAT_SIGNAL_CHANNEL, raw => {
      const event = parseSessionActivitySignal(raw);
      if (!event) return;
      setSignalActivities(current => {
        if (current[event.sessionId] === event.activity) return current;
        return { ...current, [event.sessionId]: event.activity };
      });
    });
    return unsubscribe;
  }, [apiHolder, reload]);

  const handleUnarchive = useCallback(
    (remoteId: string) => {
      onClearError();
      api
        .updateSession(remoteId, { archived: false })
        .then(() => reload())
        .catch(onActionError);
    },
    [api, onClearError, onActionError, reload],
  );

  const handleNewChat = useCallback(() => {
    navigate(`${chatBasePath}?entityRef=${encodeURIComponent(entityRef)}`);
  }, [chatBasePath, entityRef, navigate]);

  return (
    <div className={cx('chat-entity-tab')}>
      <ThreadListSidebar
        openId=""
        search={search}
        onSearchChange={onSearchChange}
        showArchived={showArchived}
        onShowArchivedChange={onShowArchivedChange}
        actionError={actionError}
        onClearError={onClearError}
        onUnarchive={handleUnarchive}
        onNewChat={handleNewChat}
        signalActivities={signalActivities}
      />
    </div>
  );
}

/**
 * Entity page tab content listing the signed-in user's sessions bound to the
 * current entity, with a button to start a new conversation for that entity.
 */
export function EntityAiChatContentView() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  const api = useApi(aiChatApiRef);
  const navigate = useNavigate();
  const rootRoute = useRouteRef(rootRouteRef);
  const chatBasePath = rootRoute().replace(/\/+$/, '') || '/ai-chat';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const reloadRef = useRef<(() => void) | undefined>();

  useEffect(() => {
    const trimmed = search.trim();
    if (!trimmed) {
      setDebouncedSearch('');
      return undefined;
    }
    const timer = setTimeout(
      () => setDebouncedSearch(trimmed),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [search]);

  const clearActionError = useCallback(() => {
    setActionError(undefined);
  }, []);

  const reportActionError = useCallback((error: unknown) => {
    setActionError(describeError(error));
  }, []);

  const adapter = useMemo(
    () =>
      createThreadListAdapter({
        api,
        entityRef,
        query: debouncedSearch,
        includeArchived: showArchived,
        onActionStart: clearActionError,
        onActionSuccess: clearActionError,
        onActionError: reportActionError,
        onCustomUpdated: () => reloadRef.current?.(),
      }),
    [
      api,
      entityRef,
      debouncedSearch,
      showArchived,
      clearActionError,
      reportActionError,
    ],
  );

  const onThreadIdChange = useCallback(
    (nextId: string | undefined) => {
      if (!nextId) return;
      navigate(`${chatBasePath}/${encodeURIComponent(nextId)}`);
    },
    [chatBasePath, navigate],
  );

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: usePlaceholderThreadRuntime,
    adapter,
    threadId: undefined,
    onThreadIdChange,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <EntityThreadListBody
        entityRef={entityRef}
        chatBasePath={chatBasePath}
        search={search}
        onSearchChange={setSearch}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        actionError={actionError}
        onClearError={clearActionError}
        onActionError={reportActionError}
        reloadRef={reloadRef}
      />
    </AssistantRuntimeProvider>
  );
}

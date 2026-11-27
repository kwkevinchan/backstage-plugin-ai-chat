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
import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type ThreadMessage,
} from '@assistant-ui/react';
import { Content, Header, Page } from '@backstage/core-components';
import { useApi, useApiHolder } from '@backstage/core-plugin-api';
import { Container } from '@backstage/ui';
import type {
  ChatAttachment,
  ChatSession,
  ChatSessionDetail,
  ChatToolset,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { aiChatApiRef } from '../api';
import type { AiChatApi } from '../api';
import type { AttachmentSource } from '../adapters/assistantUi/attachmentAdapter';
import {
  createThreadListAdapter,
  readThreadCustom,
  type SessionListActivity,
} from '../adapters/assistantUi/threadListAdapter';
import {
  AI_CHAT_SIGNAL_CHANNEL,
  parseSessionActivitySignal,
  signalApiRef,
  type SessionSignalActivity,
} from '../adapters/signals';
import { describeError } from '../adapters/describeError';
import { useInputConfig } from '../application/useInputConfig';
import { usePageContext } from '../application/usePageContext';
import type { OutgoingMessage } from '../domain/types';
import { useToolsets } from '../application/useToolsets';
import { DraftComposer } from './Composer';
import { SessionView } from './SessionView';
import { cx } from './styles';
import { ThreadListSidebar } from './ThreadListSidebar';
import { ToolsetPanel } from './ToolsetPanel';

const SEARCH_DEBOUNCE_MS = 250;
const ACTIVE_POLL_MS = 3_000;
const FALLBACK_POLL_MS = 15_000;
const TITLE_FOLLOWUP_POLL_MS = 2_000;
const EMPTY_MESSAGES: readonly ThreadMessage[] = [];
const NOOP_ON_NEW = async () => {};

/**
 * Minimal thread runtime hosted by `useRemoteThreadListRuntime`. The active
 * conversation renders its own `SessionView` with `useSessionRuntime`.
 */
function usePlaceholderThreadRuntime() {
  return useExternalStoreRuntime({
    messages: EMPTY_MESSAGES,
    onNew: NOOP_ON_NEW,
  });
}

type Basics = {
  api: AiChatApi;
  basePath: string;
  toolsets: ChatToolset[];
  liveActivity?: SessionListActivity;
  onChanged(): void;
};

/** A session opens on its own URL: `<page>/<session id>` (SE-01). */
function OpenSession({
  api,
  basePath,
  toolsets,
  liveActivity,
  onChanged,
}: Basics) {
  const { sessionId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { id: string; detail: ChatSessionDetail }
    | { id: string; error: string }
    | undefined
  >();
  // The first message of a session that was just created is in the location.
  const firstState = location.state as {
    firstMessage?: string;
    firstAttachments?: ChatAttachment[];
  } | null;
  const firstMessage = firstState?.firstMessage;
  const firstAttachments = firstState?.firstAttachments;
  const hasFirst = Boolean(firstMessage || firstAttachments?.length);

  useEffect(() => {
    let cancelled = false;
    api
      .getSession(sessionId)
      .then(detail => {
        if (!cancelled) setState({ id: sessionId, detail });
      })
      .catch(error => {
        if (!cancelled)
          setState({ id: sessionId, error: describeError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  // The session takes the message when it opens; then the location forgets it,
  // so that a reload or a return to this session does not send it again.
  const opened =
    state?.id === sessionId && state !== undefined && 'detail' in state;
  useEffect(() => {
    if (opened && hasFirst) {
      navigate(`${location.pathname}${location.search}`, {
        replace: true,
        state: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, hasFirst]);

  if (!state || state.id !== sessionId) {
    return (
      <div className={cx('chat-main')}>
        <div className={cx('chat-empty')}>Loading the conversation...</div>
      </div>
    );
  }
  if ('error' in state) {
    return (
      <div className={cx('chat-main')}>
        <div className={cx('chat-error')} role="alert">
          {state.error}
        </div>
      </div>
    );
  }
  return (
    <SessionView
      key={sessionId}
      api={api}
      detail={state.detail}
      toolsets={toolsets}
      firstMessage={firstMessage}
      firstAttachments={firstAttachments}
      liveActivity={liveActivity}
      onChanged={onChanged}
      onForked={forked => {
        onChanged();
        navigate(`${basePath}/${encodeURIComponent(forked.id)}`);
      }}
    />
  );
}

/**
 * The page of a conversation that does not exist yet. The first message
 * creates it, or the first image does: an image is uploaded to a session.
 * Then the toolsets chosen later are written to that session, and the first
 * message waits until they are.
 */
function NewSession({ api, basePath, toolsets, onChanged }: Basics) {
  const navigate = useNavigate();
  const page = usePageContext();
  const images = useInputConfig(api)?.images;
  const [enabled, setEnabled] = useState<string[]>();
  const [error, setError] = useState<string>();
  const chosen = enabled ?? toolsets.filter(t => t.default).map(t => t.id);
  const latest = useRef({ chosen, toolsets, onChanged });
  latest.current = { chosen, toolsets, onChanged };
  /** The session that the first image created, once there is one. */
  const creating = useRef<Promise<ChatSession>>();
  /** The toolsets written to that session, and the write on its way. */
  const written = useRef<string>();
  const writing = useRef<Promise<void>>();

  const toolsetsOf = () =>
    // Without a list the backend takes the default toolsets.
    latest.current.toolsets.length > 0
      ? { enabledToolsets: latest.current.chosen }
      : undefined;

  const ensureSession = () => {
    if (!creating.current) {
      const request = toolsetsOf();
      creating.current = api.createSession(request ?? {}).then(
        session => {
          written.current = request?.enabledToolsets?.join('\0');
          latest.current.onChanged();
          return session;
        },
        cause => {
          creating.current = undefined;
          throw cause;
        },
      );
    }
    return creating.current;
  };

  /** Writes the chosen toolsets to the session the first image created. */
  const writeToolsets = () => {
    const previous = writing.current ?? Promise.resolve();
    const next = previous.then(async () => {
      const session = await creating.current;
      const request = toolsetsOf();
      const key = request?.enabledToolsets?.join('\0');
      if (!session || !request || key === written.current) return;
      await api.updateSession(session.id, request);
      written.current = key;
    });
    writing.current = next.catch(() => {});
    return next;
  };

  const chosenKey = chosen.join('\0');
  useEffect(() => {
    if (!creating.current) return;
    writeToolsets().catch(cause => setError(describeError(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey]);

  const attachments = useMemo<AttachmentSource | undefined>(
    () =>
      images?.enabled
        ? {
            limits: images,
            upload: async file => {
              const session = await ensureSession();
              return api.uploadAttachment(session.id, file, file.name);
            },
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, images],
  );

  const send = async (message: OutgoingMessage) => {
    try {
      const existing = creating.current;
      const session = await ensureSession();
      // A change of the toolsets after the first image must reach the
      // session before its first run.
      if (existing) await writeToolsets();
      setError(undefined);
      navigate(
        `${basePath}/${encodeURIComponent(session.id)}${
          page.entityRef
            ? `?entityRef=${encodeURIComponent(page.entityRef)}`
            : ''
        }`,
        {
          state: {
            firstMessage: message.text,
            ...(message.attachments?.length && {
              firstAttachments: message.attachments,
            }),
          },
        },
      );
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  };

  return (
    <div className={cx('chat-main')}>
      <ToolsetPanel
        toolsets={toolsets}
        enabled={chosen}
        onChange={setEnabled}
      />
      <div className={cx('chat-timeline')} aria-live="polite" aria-busy="false">
        <div className={cx('chat-empty')}>
          Ask a question. The assistant can use the actions of Backstage as you.
          Actions that only read run at once; every action that changes
          something waits for your approval here.
        </div>
        {error && (
          <div className={cx('chat-error')} role="alert">
            {error}
          </div>
        )}
      </div>
      <DraftComposer onSend={send} disabled={false} attachments={attachments} />
    </div>
  );
}

interface ChatPageBodyProps {
  api: AiChatApi;
  basePath: string;
  openId: string;
  toolsets: ChatToolset[];
  search: string;
  onSearchChange(value: string): void;
  showArchived: boolean;
  onShowArchivedChange(value: boolean): void;
  actionError?: string;
  onActionError(error: unknown): void;
  onClearError(): void;
  reloadRef: React.MutableRefObject<(() => void) | undefined>;
}

function ChatPageBody(props: ChatPageBodyProps) {
  const {
    api,
    basePath,
    openId,
    toolsets,
    search,
    onSearchChange,
    showArchived,
    onShowArchivedChange,
    actionError,
    onActionError,
    onClearError,
    reloadRef,
  } = props;
  const aui = useAui();
  const navigate = useNavigate();
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

  reloadRef.current = reloadList;

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

  const liveActivity = useMemo<SessionListActivity | undefined>(() => {
    if (!openId) return undefined;
    const pushed = signalActivities[openId];
    if (pushed === 'running' || pushed === 'waiting_approval') return pushed;
    if (pushed === 'idle' || pushed === 'replied') return undefined;
    const match = threadItems.find(
      item => item.remoteId === openId || item.id === openId,
    );
    return readThreadCustom(match?.custom).activity;
  }, [openId, signalActivities, threadItems]);

  const handleNewChat = useCallback(() => {
    aui.threads.switchToNewThread();
    navigate(basePath || '/');
  }, [aui, basePath, navigate]);

  const handleUnarchive = useCallback(
    async (remoteId: string) => {
      onClearError();
      try {
        await api.updateSession(remoteId, { archived: false });
        reloadList();
      } catch (error) {
        onActionError(error);
      }
    },
    [api, onActionError, onClearError, reloadList],
  );

  const basics: Basics = {
    api,
    basePath,
    toolsets,
    liveActivity,
    onChanged: reloadList,
  };

  return (
    <div className={cx('chat-layout')}>
      <ThreadListSidebar
        openId={openId}
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
      <Routes>
        <Route index element={<NewSession {...basics} />} />
        <Route path=":sessionId" element={<OpenSession {...basics} />} />
      </Routes>
    </div>
  );
}

/** The list of sessions, the open session and the input box. */
export function ChatPageContent() {
  const api = useApi(aiChatApiRef);
  const toolsets = useToolsets(api);
  const navigate = useNavigate();
  const location = useLocation();
  // The page is mounted on a route that ends with `/*`: what the splat
  // matched is the session id, and the path before it is where the page is.
  const rest = (useParams()['*'] ?? '').split('/').filter(Boolean);
  const basePath = location.pathname
    .split('/')
    .filter(Boolean)
    .slice(0, -rest.length || undefined)
    .map(segment => `/${segment}`)
    .join('');
  const openId = rest[0] ? decodeURIComponent(rest[0]) : '';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const basePathRef = useRef(basePath);
  basePathRef.current = basePath;
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

  const handleDeletedRef = useRef((remoteId: string) => {
    if (remoteId === openIdRef.current) {
      navigate(basePathRef.current || '/');
    }
  });
  handleDeletedRef.current = (remoteId: string) => {
    if (remoteId === openIdRef.current) {
      navigate(basePathRef.current || '/');
    }
  };

  const adapter = useMemo(
    () =>
      createThreadListAdapter({
        api,
        query: debouncedSearch,
        includeArchived: showArchived,
        onActionStart: clearActionError,
        onActionSuccess: clearActionError,
        onActionError: reportActionError,
        onCustomUpdated: () => reloadRef.current?.(),
        onDeleted: id => handleDeletedRef.current(id),
      }),
    [api, debouncedSearch, showArchived, clearActionError, reportActionError],
  );

  const onThreadIdChange = useCallback(
    (nextId: string | undefined) => {
      // Archive stays on the current URL and delete navigates in `onDeleted`,
      // so `undefined` from assistant-ui never triggers navigation.
      if (nextId === undefined) return;
      if (nextId !== openId) {
        navigate(`${basePath}/${encodeURIComponent(nextId)}`);
      }
    },
    [basePath, navigate, openId],
  );

  const threadListRuntime = useRemoteThreadListRuntime({
    adapter,
    threadId: openId || undefined,
    onThreadIdChange,
    runtimeHook: usePlaceholderThreadRuntime,
  });

  return (
    <AssistantRuntimeProvider runtime={threadListRuntime}>
      <ChatPageBody
        api={api}
        basePath={basePath}
        openId={openId}
        toolsets={toolsets}
        search={search}
        onSearchChange={setSearch}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        actionError={actionError}
        onActionError={reportActionError}
        onClearError={clearActionError}
        reloadRef={reloadRef}
      />
    </AssistantRuntimeProvider>
  );
}

/** The page for the new frontend system, under the page header of the app. */
export function ChatPageInContainer() {
  return (
    <Container>
      <ChatPageContent />
    </Container>
  );
}

/** The page with its own header, for the legacy frontend system. */
export function ChatPageWithHeader() {
  return (
    <Page themeId="tool">
      <Header title="AI chat" subtitle="Ask, and approve what changes" />
      <Content>
        <ChatPageContent />
      </Content>
    </Page>
  );
}

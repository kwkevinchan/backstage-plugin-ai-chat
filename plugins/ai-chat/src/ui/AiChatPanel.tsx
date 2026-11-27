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
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  identityApiRef,
  useApi,
  useApiHolder,
} from '@backstage/core-plugin-api';
import type {
  ChatAttachment,
  ChatSession,
  ChatSessionDetail,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { aiChatPanelApiRef } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { aiChatApiRef } from '../api';
import type { AttachmentSource } from '../adapters/assistantUi/attachmentAdapter';
import { describeError } from '../adapters/describeError';
import {
  getAiChatPanelStore,
  type AiChatPanelStore,
} from '../application/panelStore';
import { useInputConfig } from '../application/useInputConfig';
import { usePageContext } from '../application/usePageContext';
import { useToolsets } from '../application/useToolsets';
import { panelMessagePage } from '../domain/launch';
import type { PanelState } from '../domain/panel';
import type { OutgoingMessage } from '../domain/types';
import { DraftComposer } from './Composer';
import { SessionView } from './SessionView';
import { cx } from './styles';

interface HeldSession {
  sessionId: string;
  detail: ChatSessionDetail;
  firstMessage?: string;
  firstAttachments?: ChatAttachment[];
}

/**
 * The side panel of the chat. Render it once, inside the router and outside
 * the routes, so a conversation stays mounted when the page changes. The new
 * frontend system mounts this at the app root.
 *
 * Nothing renders while the user has not finished signing in. A conversation
 * that has started stays mounted while the panel is closed, so a run is not
 * stopped by closing it or by changing page. Before the first message the
 * closed panel is only the button on the edge.
 *
 * @public
 */
export function AiChatPanel(): JSX.Element | null {
  const identityApi = useApiHolder().get(identityApiRef);
  const [signedIn, setSignedIn] = useState(!identityApi);

  useEffect(() => {
    if (!identityApi) {
      setSignedIn(true);
      return () => undefined;
    }
    let cancelled = false;
    setSignedIn(false);
    identityApi.getBackstageIdentity().then(
      () => {
        if (!cancelled) setSignedIn(true);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [identityApi]);

  if (!signedIn) return null;
  return <AiChatPanelInner />;
}

function AiChatPanelInner() {
  const panelApi = useApi(aiChatPanelApiRef);
  const store = getAiChatPanelStore(panelApi);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const showConversation = state.open || state.sessionId !== undefined;
  const tabRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(state.open);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = state.open;

    if (state.open && !wasOpen) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !asideRef.current?.contains(active)
      ) {
        openerRef.current = active;
      }
      const input =
        asideRef.current?.querySelector<HTMLTextAreaElement>('textarea');
      input?.focus();
    } else if (!state.open && wasOpen) {
      const active = document.activeElement;
      const shouldRestore =
        !active ||
        active === document.body ||
        Boolean(asideRef.current?.contains(active));
      const target =
        openerRef.current && openerRef.current.isConnected
          ? openerRef.current
          : tabRef.current;
      openerRef.current = null;
      if (shouldRestore) {
        target?.focus();
      }
    }
  }, [state.open]);

  useEffect(() => {
    const aside = asideRef.current;
    if (!state.open || !aside) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        panelApi.close();
      }
    };
    aside.addEventListener('keydown', onKeyDown);
    return () => aside.removeEventListener('keydown', onKeyDown);
  }, [panelApi, showConversation, state.open]);

  return (
    <>
      {!state.open && (
        <button
          ref={tabRef}
          type="button"
          className={cx('panel-tab')}
          aria-label="Open AI chat"
          aria-expanded={false}
          onClick={() => {
            openerRef.current = null;
            panelApi.open();
          }}
        >
          AI chat
        </button>
      )}
      {showConversation && (
        <aside
          ref={asideRef}
          className={cx('panel-frame')}
          hidden={!state.open}
          aria-label="AI chat"
        >
          <div className={cx('panel-bar')}>
            <span>AI chat</span>
            <button
              type="button"
              aria-label="Close AI chat"
              onClick={() => panelApi.close()}
            >
              Close
            </button>
          </div>
          <div className={cx('panel-body')}>
            <PanelConversation
              store={store}
              state={state}
              asideRef={asideRef}
            />
          </div>
        </aside>
      )}
    </>
  );
}

/** The one conversation on the panel. Not mounted until the panel opens or a conversation exists. */
function PanelConversation(props: {
  store: AiChatPanelStore;
  state: PanelState;
  asideRef: React.RefObject<HTMLElement>;
}) {
  const { store, state, asideRef } = props;
  const api = useApi(aiChatApiRef);
  const toolsets = useToolsets(api);
  const inputConfig = useInputConfig(api);
  const images = inputConfig?.images;
  const live = usePageContext();
  const page = panelMessagePage(state.launch, live);
  const [held, setHeld] = useState<HeldSession>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const creating = useRef<Promise<ChatSession>>();
  const active = held && held.sessionId === state.sessionId ? held : undefined;

  // Keep focus in the panel composer when DraftComposer swaps to SessionView
  // (e.g. launching with a prompt or sending the first message).
  const activeSessionId = active?.sessionId;
  useEffect(() => {
    if (!state.open || !activeSessionId) return;
    const focused = document.activeElement;
    if (
      !focused ||
      focused === document.body ||
      asideRef.current?.contains(focused)
    ) {
      asideRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }
  }, [activeSessionId, asideRef, state.open]);

  const prompt = state.launch?.prompt;
  const launchId = state.launchId;
  const sessionId = state.sessionId;
  const { setSession, start } = store;
  const launchIdRef = useRef(launchId);
  launchIdRef.current = launchId;

  const defaultToolsets = () =>
    toolsets.length > 0
      ? {
          enabledToolsets: toolsets
            .filter(item => item.default)
            .map(item => item.id),
        }
      : undefined;

  const ensureDraftSession = (): Promise<ChatSession> => {
    if (!creating.current) {
      creating.current = api.createSession(defaultToolsets()).catch(cause => {
        creating.current = undefined;
        throw cause;
      });
    }
    return creating.current;
  };

  useEffect(() => {
    if (!prompt || sessionId) return () => undefined;
    let cancelled = false;
    setOpening(true);
    setError(undefined);
    const promise = start(launchId, async () => {
      const created = await api.createSession(
        toolsets.length > 0
          ? {
              enabledToolsets: toolsets
                .filter(item => item.default)
                .map(item => item.id),
            }
          : undefined,
      );
      const loaded = await api.getSession(created.id);
      return {
        sessionId: created.id,
        detail: loaded,
        firstMessage: prompt,
      };
    });
    promise.then(
      result => {
        // A remount shares the promise. Its own flag is the one that applies
        // the result. A newer launch leaves this result unused.
        if (cancelled || launchIdRef.current !== launchId) return;
        creating.current = undefined;
        setHeld(result);
        setSession(result.sessionId);
        setOpening(false);
      },
      (cause: unknown) => {
        if (cancelled || launchIdRef.current !== launchId) return;
        setError(describeError(cause));
        setOpening(false);
      },
    );
    return () => {
      cancelled = true;
      setOpening(false);
    };
  }, [api, launchId, prompt, sessionId, setSession, start, toolsets]);

  const attachments = useMemo<AttachmentSource | undefined>(
    () =>
      images?.enabled
        ? {
            limits: images,
            upload: async file => {
              const created = await ensureDraftSession();
              return api.uploadAttachment(created.id, file, file.name);
            },
            remove: async attachmentId => {
              const created = creating.current
                ? await creating.current
                : undefined;
              if (created) await api.deleteAttachment(created.id, attachmentId);
            },
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, images],
  );

  const send = async (message: OutgoingMessage) => {
    setOpening(true);
    setError(undefined);
    try {
      const created = await ensureDraftSession();
      const loaded = await api.getSession(created.id);
      creating.current = undefined;
      setHeld({
        sessionId: created.id,
        detail: loaded,
        firstMessage: message.text,
        ...(message.attachments?.length && {
          firstAttachments: message.attachments,
        }),
      });
      setSession(created.id);
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setOpening(false);
    }
  };

  if (active) {
    return (
      <SessionView
        key={active.sessionId}
        api={api}
        detail={active.detail}
        toolsets={toolsets}
        firstMessage={active.firstMessage}
        firstAttachments={active.firstAttachments}
        page={page}
      />
    );
  }

  return (
    <div className={cx('chat-main')}>
      <div className={cx('chat-empty')}>
        Ask a question. The assistant can use the actions of Backstage as you.
        Actions that only read run at once; every action that changes something
        waits for your approval here.
      </div>
      {error && (
        <div className={cx('chat-error')} role="alert">
          {error}
        </div>
      )}
      <DraftComposer
        onSend={send}
        disabled={opening}
        attachments={attachments}
      />
    </div>
  );
}

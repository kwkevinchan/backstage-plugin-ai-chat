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

import { useEffect, useRef, useState } from 'react';
import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { Content, Header, Page } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react';
import { Button, Container } from '@backstage/ui';
import type {
  ChatAttachment,
  ChatSession,
  ChatSessionDetail,
  ChatToolset,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { aiChatApiRef } from '../api';
import type { AiChatApi } from '../api';
import { describeError } from '../adapters/describeError';
import { useInputConfig } from '../application/useInputConfig';
import { usePageContext } from '../application/usePageContext';
import type { OutgoingMessage } from '../domain/types';
import { useSessionList } from '../application/useSessionList';
import { useToolsets } from '../application/useToolsets';
import { Composer } from './Composer';
import { SessionView } from './SessionView';
import { cx } from './styles';
import { ToolsetPanel } from './ToolsetPanel';

type Basics = {
  api: AiChatApi;
  basePath: string;
  toolsets: ChatToolset[];
  onChanged(): void;
};

/** A session opens on its own URL: `<page>/<session id>` (SE-01). */
function OpenSession({ api, toolsets, onChanged }: Basics) {
  const { sessionId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { id: string; detail: ChatSessionDetail }
    | { id: string; error: string }
    | undefined
  >();
  // The first message of a session that was just created is in the location.
  const navState = location.state as {
    firstMessage?: string;
    attachments?: ChatAttachment[];
  } | null;
  const firstMessage = navState?.firstMessage;
  const firstAttachments = navState?.attachments;

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
    if (
      opened &&
      (firstMessage || (firstAttachments && firstAttachments.length > 0))
    ) {
      navigate(`${location.pathname}${location.search}`, {
        replace: true,
        state: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, firstMessage, firstAttachments]);

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
      onChanged={onChanged}
    />
  );
}

/** The page of a conversation that does not exist yet: the first message creates it. */
function NewSession({ api, basePath, toolsets, onChanged }: Basics) {
  const navigate = useNavigate();
  const page = usePageContext();
  const inputConfig = useInputConfig(api);
  const [enabled, setEnabled] = useState<string[]>();
  const [error, setError] = useState<string>();
  const chosen = enabled ?? toolsets.filter(t => t.default).map(t => t.id);
  const chosenKey = chosen.join('\0');
  const chosenRef = useRef(chosen);
  const toolsetsRef = useRef(toolsets);
  chosenRef.current = chosen;
  toolsetsRef.current = toolsets;
  const sessionRef = useRef<ChatSession>();
  const creatingRef = useRef<Promise<ChatSession>>();
  const createdWith = useRef<string>();

  // The first image creates the session, and the first message reuses it.
  // A later change of the toolsets is written onto that session.
  const ensureSession = () => {
    if (sessionRef.current) return Promise.resolve(sessionRef.current);
    if (!creatingRef.current) {
      const atCreate = chosenRef.current;
      const sendToolsets = toolsetsRef.current.length > 0;
      creatingRef.current = api
        .createSession(
          // Without a list the backend takes the default toolsets.
          sendToolsets ? { enabledToolsets: atCreate } : undefined,
        )
        .then(session => {
          sessionRef.current = session;
          createdWith.current = sendToolsets ? atCreate.join('\0') : '';
          onChanged();
          return session;
        })
        .catch(cause => {
          creatingRef.current = undefined;
          throw cause;
        });
    }
    return creatingRef.current;
  };

  useEffect(() => {
    let cancelled = false;
    const wanted = chosenRef.current;
    const wantedKey = wanted.join('\0');
    const active = Boolean(sessionRef.current || creatingRef.current);
    const alreadyWritten =
      Boolean(sessionRef.current) && createdWith.current === wantedKey;
    if (active && !alreadyWritten) {
      (async () => {
        try {
          const session = sessionRef.current ?? (await creatingRef.current);
          if (!session || cancelled) return;
          if (chosenRef.current.join('\0') !== wantedKey) return;
          if (createdWith.current === wantedKey) return;
          await api.updateSession(session.id, { enabledToolsets: wanted });
          createdWith.current = wantedKey;
        } catch (cause) {
          if (!cancelled) setError(describeError(cause));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [api, chosenKey]);

  const imageLimits = inputConfig?.images.enabled
    ? {
        mediaTypes: inputConfig.images.mediaTypes,
        maxPerMessage: inputConfig.images.maxPerMessage,
        maxBytes: inputConfig.images.maxBytes,
      }
    : undefined;

  const uploadImage = async (
    file: File,
    onProgress: (loaded: number, total: number) => void,
  ) => {
    try {
      const session = await ensureSession();
      return await api.uploadAttachment(
        session.id,
        file,
        file.name,
        onProgress,
      );
    } catch (cause) {
      throw new Error(describeError(cause));
    }
  };

  const send = async (draft: OutgoingMessage) => {
    try {
      const session = await ensureSession();
      navigate(
        `${basePath}/${encodeURIComponent(session.id)}${
          page.entityRef
            ? `?entityRef=${encodeURIComponent(page.entityRef)}`
            : ''
        }`,
        {
          state: {
            firstMessage: draft.text,
            ...(draft.attachments &&
              draft.attachments.length > 0 && {
                attachments: draft.attachments,
              }),
          },
        },
      );
      return true;
    } catch (cause) {
      setError(describeError(cause));
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
      <Composer
        onSend={send}
        disabled={false}
        images={imageLimits}
        uploadImage={imageLimits ? uploadImage : undefined}
      />
    </div>
  );
}

/** The list of sessions, the open session and the input box. */
export function ChatPageContent() {
  const api = useApi(aiChatApiRef);
  const list = useSessionList(api);
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
  const basics: Basics = {
    api,
    basePath,
    toolsets,
    onChanged: list.refresh,
  };

  return (
    <div className={cx('chat-layout')}>
      <nav className={cx('chat-sidebar')} aria-label="Conversations">
        <Button
          variant="secondary"
          iconStart={<RiAddLine size="1em" />}
          onPress={() => navigate(basePath || '/')}
        >
          New chat
        </Button>
        {list.error && (
          <div className={cx('chat-error')} role="alert">
            {list.error}
          </div>
        )}
        {list.sessions.map(session => {
          const title = session.title ?? 'New conversation';
          return (
            <div
              key={session.id}
              className={cx(
                'chat-conversation',
                session.id === openId && 'chat-conversation-selected',
              )}
            >
              <button
                type="button"
                className={cx('chat-conversation-open')}
                aria-current={session.id === openId}
                onClick={() =>
                  navigate(`${basePath}/${encodeURIComponent(session.id)}`)
                }
              >
                {title}
              </button>
              <button
                type="button"
                className={cx('chat-icon-button')}
                aria-label={`Delete conversation ${title}`}
                onClick={async () => {
                  if (
                    (await list.remove(session.id)) &&
                    session.id === openId
                  ) {
                    navigate(basePath || '/');
                  }
                }}
              >
                <RiDeleteBinLine size="1em" />
              </button>
            </div>
          );
        })}
      </nav>
      <Routes>
        <Route index element={<NewSession {...basics} />} />
        <Route path=":sessionId" element={<OpenSession {...basics} />} />
      </Routes>
    </div>
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

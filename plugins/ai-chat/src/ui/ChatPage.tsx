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

import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { AttachmentSource } from '../adapters/assistantUi/attachmentAdapter';
import { describeError } from '../adapters/describeError';
import { useInputConfig } from '../application/useInputConfig';
import { usePageContext } from '../application/usePageContext';
import type { OutgoingMessage } from '../domain/types';
import { useSessionList } from '../application/useSessionList';
import { useToolsets } from '../application/useToolsets';
import { DraftComposer } from './Composer';
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
      onChanged={onChanged}
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

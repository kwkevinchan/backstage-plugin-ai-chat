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
import {
  RiAddLine,
  RiArchiveLine,
  RiDeleteBinLine,
  RiInboxUnarchiveLine,
  RiPencilLine,
  RiPushpinFill,
  RiPushpinLine,
} from '@remixicon/react';
import { Button, Container } from '@backstage/ui';
import type {
  ChatSession,
  ChatSessionDetail,
  ChatToolset,
  UpdateChatSessionRequest,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { aiChatApiRef } from '../api';
import type { AiChatApi } from '../api';
import { describeError } from '../adapters/describeError';
import { usePageContext } from '../application/usePageContext';
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
  const firstMessage = (location.state as { firstMessage?: string } | null)
    ?.firstMessage;

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
    if (opened && firstMessage) {
      navigate(`${location.pathname}${location.search}`, {
        replace: true,
        state: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, firstMessage]);

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
      onChanged={onChanged}
    />
  );
}

/** The page of a conversation that does not exist yet: the first message creates it. */
function NewSession({ api, basePath, toolsets, onChanged }: Basics) {
  const navigate = useNavigate();
  const page = usePageContext();
  const [enabled, setEnabled] = useState<string[]>();
  const [error, setError] = useState<string>();
  const chosen = enabled ?? toolsets.filter(t => t.default).map(t => t.id);

  const send = async (text: string) => {
    try {
      const session = await api.createSession({
        // Without a list the backend takes the default toolsets.
        ...(toolsets.length > 0 && { enabledToolsets: chosen }),
      });
      onChanged();
      navigate(
        `${basePath}/${encodeURIComponent(session.id)}${
          page.entityRef
            ? `?entityRef=${encodeURIComponent(page.entityRef)}`
            : ''
        }`,
        { state: { firstMessage: text } },
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
      <Composer onSend={send} disabled={false} />
    </div>
  );
}

/** One row of the session list: open, pin, rename, archive or delete (SE-03). */
function SessionRow({
  session,
  selected,
  onOpen,
  onChange,
  onDelete,
}: {
  session: ChatSession;
  selected: boolean;
  onOpen(): void;
  onChange(id: string, patch: UpdateChatSessionRequest): Promise<boolean>;
  onDelete(): void;
}) {
  const title = session.title ?? 'New conversation';
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const committed = useRef(false);
  const renameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);

  const save = () => {
    if (committed.current) return;
    committed.current = true;
    setRenaming(false);
    const next = draft.trim();
    if (next.length === 0 || next === title) return;
    void onChange(session.id, { title: next });
  };

  return (
    <div
      className={cx(
        'chat-conversation',
        selected && 'chat-conversation-selected',
      )}
    >
      {renaming ? (
        <input
          className={cx('chat-rename-input')}
          aria-label={`Title for ${title}`}
          value={draft}
          ref={renameInput}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape') {
              committed.current = true;
              setRenaming(false);
            }
          }}
          onBlur={save}
        />
      ) : (
        <button
          type="button"
          className={cx('chat-conversation-open')}
          aria-current={selected}
          onClick={onOpen}
        >
          {title}
        </button>
      )}
      <button
        type="button"
        className={cx(
          'chat-icon-button',
          session.pinned && 'chat-icon-button-on',
        )}
        aria-label={`${session.pinned ? 'Unpin' : 'Pin'} conversation ${title}`}
        aria-pressed={session.pinned}
        onClick={() => void onChange(session.id, { pinned: !session.pinned })}
      >
        {session.pinned ? (
          <RiPushpinFill size="1em" />
        ) : (
          <RiPushpinLine size="1em" />
        )}
      </button>
      <button
        type="button"
        className={cx('chat-icon-button')}
        aria-label={`Rename conversation ${title}`}
        onClick={() => {
          committed.current = false;
          setDraft(title);
          setRenaming(true);
        }}
      >
        <RiPencilLine size="1em" />
      </button>
      <button
        type="button"
        className={cx('chat-icon-button')}
        aria-label={`${
          session.archivedAt ? 'Restore' : 'Archive'
        } conversation ${title}`}
        onClick={() =>
          void onChange(session.id, { archived: !session.archivedAt })
        }
      >
        {session.archivedAt ? (
          <RiInboxUnarchiveLine size="1em" />
        ) : (
          <RiArchiveLine size="1em" />
        )}
      </button>
      <button
        type="button"
        className={cx('chat-icon-button')}
        aria-label={`Delete conversation ${title}`}
        onClick={onDelete}
      >
        <RiDeleteBinLine size="1em" />
      </button>
      {session.archivedAt && (
        <span className={cx('chat-conversation-archived')}>Archived</span>
      )}
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
        <input
          className={cx('chat-search')}
          aria-label="Search conversations"
          placeholder="Search"
          value={list.query}
          onChange={event => list.setQuery(event.target.value)}
        />
        <label className={cx('chat-show-archived')}>
          <input
            type="checkbox"
            checked={list.includeArchived}
            onChange={event => list.setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
        {list.error && (
          <div className={cx('chat-error')} role="alert">
            {list.error}
          </div>
        )}
        {list.sessions.map(session => (
          <SessionRow
            key={session.id}
            session={session}
            selected={session.id === openId}
            onOpen={() =>
              navigate(`${basePath}/${encodeURIComponent(session.id)}`)
            }
            onChange={list.change}
            onDelete={async () => {
              if ((await list.remove(session.id)) && session.id === openId) {
                navigate(basePath || '/');
              }
            }}
          />
        ))}
        {list.sessions.length === 0 && list.query.trim() !== '' && (
          <div className={cx('chat-empty-list')}>No conversations match.</div>
        )}
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

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
import { useApi } from '@backstage/core-plugin-api';
import type { ChatSessionDetail } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import {
  panelMessagePage,
  useAiChatPanel,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { aiChatApiRef } from '../api';
import { describeError } from '../adapters/describeError';
import { usePageContext } from '../application/usePageContext';
import { useToolsets } from '../application/useToolsets';
import { Composer } from './Composer';
import { SessionView } from './SessionView';
import { cx } from './styles';

interface HeldSession {
  sessionId: string;
  detail: ChatSessionDetail;
  firstMessage?: string;
}

/**
 * The side panel of the chat. Render it once, inside the router and outside
 * the routes, so a conversation stays mounted when the page changes. The new
 * frontend system mounts this at the app root.
 *
 * A conversation that has started stays mounted while the panel is closed, so
 * a run is not stopped by closing it or by changing page. Before the first
 * message the closed panel is only the button on the edge.
 *
 * @public
 */
export function AiChatPanel() {
  const panel = useAiChatPanel();
  const showConversation = panel.isOpen || panel.sessionId !== undefined;
  return (
    <>
      {!panel.isOpen && (
        <button
          type="button"
          className={cx('panel-tab')}
          aria-label="Open AI chat"
          onClick={() => panel.open()}
        >
          AI chat
        </button>
      )}
      {showConversation && (
        <aside
          className={cx('panel-frame')}
          hidden={!panel.isOpen}
          aria-label="AI chat"
        >
          <div className={cx('panel-bar')}>
            <span>AI chat</span>
            <button
              type="button"
              aria-label="Close AI chat"
              onClick={() => panel.close()}
            >
              Close
            </button>
          </div>
          <div className={cx('panel-body')}>
            <PanelConversation />
          </div>
        </aside>
      )}
    </>
  );
}

/** The one conversation on the panel. Not mounted until the panel opens or a conversation exists. */
function PanelConversation() {
  const api = useApi(aiChatApiRef);
  const toolsets = useToolsets(api);
  const live = usePageContext();
  const panel = useAiChatPanel();
  const page = panelMessagePage(panel.launch, live);
  const [held, setHeld] = useState<HeldSession>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const active = held && held.sessionId === panel.sessionId ? held : undefined;

  const prompt = panel.launch?.prompt;
  const launchId = panel.launchId;
  const sessionId = panel.sessionId;
  const { setSession, start } = panel;
  const launchIdRef = useRef(launchId);
  launchIdRef.current = launchId;

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
    };
  }, [api, launchId, prompt, sessionId, setSession, start, toolsets]);

  const send = async (text: string) => {
    setOpening(true);
    setError(undefined);
    try {
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
      setHeld({ sessionId: created.id, detail: loaded, firstMessage: text });
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
      <Composer onSend={send} disabled={opening} />
    </div>
  );
}

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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { Button } from '@backstage/ui';
import { aiChatToolResultsApiRef } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import type {
  ChatAttachment,
  ChatPageContext,
  ChatSession,
  ChatSessionDetail,
  ChatShare,
  ChatToolset,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import type { AttachmentSource } from '../adapters/assistantUi/attachmentAdapter';
import { useQueueAdapter } from '../adapters/assistantUi/queueAdapter';
import { useSessionRuntime } from '../adapters/assistantUi/sessionRuntime';
import { describeError } from '../adapters/describeError';
import { useSessionChat } from '../application/useSessionChat';
import { useSessionTools } from '../application/useSessionTools';
import { useInputConfig } from '../application/useInputConfig';
import { usePageContext } from '../application/usePageContext';
import { AttachmentLoaderContext, RejectionNotes } from './Attachments';
import { Composer } from './Composer';
import { ComposerQueue } from './ComposerQueue';
import { MessageList } from './MessageList';
import { ShareDialog } from './ShareDialog';
import { cx } from './styles';
import { ToolsetPanel } from './ToolsetPanel';

/** The limit of the queue until the input config has answered (the default of the backend). */
const DEFAULT_QUEUE_MAX = 5;

function formatShareTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface SessionViewProps {
  api: AiChatApi;
  detail: ChatSessionDetail;
  toolsets: ChatToolset[];
  /** The message to send when the session opens, for a session just created. */
  firstMessage?: string;
  /** Images of that first message. */
  firstAttachments?: ChatAttachment[];
  /**
   * The page of each message. The panel passes the launch and the path at
   * send time. Omitted, the route is used.
   */
  page?: ChatPageContext;
  /** Live run activity from the session list (Signals or fallback polling). */
  liveActivity?: ChatSession['activity'];
  onChanged?(): void;
  /** Called after a sharee copies this session into their own new session (SH-04). */
  onForked?(session: ChatSession): void;
}

/** One session: its messages, the toolsets, the input box. Keyed by the session. */
export function SessionView(props: SessionViewProps) {
  const { api, detail, toolsets } = props;
  const routePage = usePageContext();
  const page = props.page ?? routePage;
  const chat = useSessionChat({
    api,
    detail,
    page,
    firstMessage: props.firstMessage,
    firstAttachments: props.firstAttachments,
    liveActivity: props.liveActivity,
    onChanged: props.onChanged,
  });
  const sessionId = detail.session.id;
  const [enabled, setEnabled] = useState(detail.session.enabledToolsets);
  const tools = useSessionTools(api, detail.session.id, enabled.join(','));
  const toolResults = useApiHolder().get(aiChatToolResultsApiRef);
  const [toolsetError, setToolsetError] = useState<string>();

  const changeToolsets = useCallback(
    async (next: string[]) => {
      const before = enabled;
      setEnabled(next);
      try {
        const session = await api.updateSession(detail.session.id, {
          enabledToolsets: next,
        });
        setEnabled(session.enabledToolsets);
        setToolsetError(undefined);
      } catch (error) {
        setEnabled(before);
        setToolsetError(describeError(error));
      }
    },
    [api, detail.session.id, enabled],
  );

  const running = Boolean(chat.activeRun);
  const waiting = chat.activeRun?.status === 'waiting_approval';
  // A run that goes on, or a response on its way before the run is known.
  const inRun = running || chat.busy;
  const inputConfig = useInputConfig(api);
  const queueMax = inputConfig?.queueMaxMessages ?? DEFAULT_QUEUE_MAX;
  const rejections = useMemo(() => new RejectionNotes(), []);
  const images = inputConfig?.images;
  const attachments = useMemo<AttachmentSource | undefined>(
    () =>
      images?.enabled
        ? {
            limits: images,
            upload: file => api.uploadAttachment(sessionId, file, file.name),
            remove: attachmentId =>
              api.deleteAttachment(sessionId, attachmentId),
            onAdd: rejections.begin,
          }
        : undefined,
    [api, images, rejections, sessionId],
  );
  const loadAttachment = useCallback(
    (attachmentId: string) => api.readAttachment(sessionId, attachmentId),
    [api, sessionId],
  );
  const queue = useQueueAdapter({
    queued: chat.queue,
    inserted: chat.pending,
    send: chat.send,
    queueMessage: chat.queueMessage,
    editQueued: chat.editQueued,
    removeQueued: chat.removeQueued,
    moveQueued: chat.moveQueued,
    insertQueued: chat.insertQueued,
  });
  const runtime = useSessionRuntime({
    messages: chat.messages,
    isRunning: inRun,
    // A response on its way before its run is known, or a run of the queue
    // that this page is about to follow: the next message would not know
    // where to go.
    isSendDisabled: chat.followingNext || (chat.busy && !running),
    onSend: chat.send,
    onStop: chat.stop,
    onDecide: chat.decide,
    queue,
    attachments,
  });
  // While a run goes on the box takes messages: Enter inserts, Ctrl or Cmd
  // with Enter queues, and a run that waits for a decision only queues.
  let hint: string | undefined;
  let placeholder: string | undefined;
  if (waiting) {
    hint =
      'An action waits for your decision. New messages can only be queued; they are sent when the run ends.';
    placeholder = 'Write a message to queue (Enter or Ctrl/Cmd+Enter queues)';
  } else if (running) {
    placeholder =
      'Write a message (Enter adds it to the run, Ctrl/Cmd+Enter queues it, Shift+Enter starts a new line)';
  } else if (chat.queuePaused) {
    hint = 'After you send, the queue continues when this run ends.';
  }

  const shared = detail.shared;
  const [shares, setShares] = useState<ChatShare[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareError, setShareError] = useState<string>();
  const [forking, setForking] = useState(false);

  useEffect(() => {
    if (shared) return () => undefined;
    let cancelled = false;
    api
      .listShares(sessionId)
      .then(list => {
        if (!cancelled) setShares(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, shared]);

  const activeLiveShares = shares.filter(s => s.mode === 'live' && !s.expired);

  const stopLiveShare = async (shareId: string) => {
    setShareError(undefined);
    try {
      await api.revokeShare(sessionId, shareId);
      setShares(prev => prev.filter(s => s.id !== shareId));
    } catch (cause) {
      setShareError(describeError(cause));
    }
  };

  const fork = async () => {
    setForking(true);
    setShareError(undefined);
    try {
      const created = await api.forkSession(sessionId);
      props.onForked?.(created);
    } catch (cause) {
      setShareError(describeError(cause));
    } finally {
      setForking(false);
    }
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AttachmentLoaderContext.Provider value={loadAttachment}>
        <ThreadPrimitive.Root className={cx('chat-main')}>
          {!shared && activeLiveShares.length > 0 && (
            <div
              className={cx('share-live-banner')}
              role="status"
              aria-label="Live sharing"
            >
              <span>Live sharing with:</span>
              {activeLiveShares.map(share => (
                <span key={share.id} className={cx('share-live-recipient')}>
                  <span>{share.subjectRef}</span>
                  <Button
                    variant="tertiary"
                    size="small"
                    onPress={() => stopLiveShare(share.id)}
                    aria-label={`Stop live sharing with ${share.subjectRef}`}
                  >
                    Stop
                  </Button>
                </span>
              ))}
            </div>
          )}
          {shared && (
            <div
              className={cx('share-readonly-banner')}
              role="status"
              aria-label="Shared conversation"
            >
              <span>
                {shared.mode === 'snapshot'
                  ? `Shared snapshot${
                      shared.snapshotAt
                        ? ` (${formatShareTime(shared.snapshotAt)})`
                        : ''
                    } — read-only`
                  : `Shared live conversation${
                      shared.expiresAt
                        ? ` (expires ${formatShareTime(shared.expiresAt)})`
                        : ''
                    } — read-only`}
              </span>
              <Button
                variant="secondary"
                size="small"
                isDisabled={forking}
                onPress={fork}
              >
                {forking ? 'Copying…' : 'Copy to my sessions'}
              </Button>
            </div>
          )}
          {!shared && (
            <div className={cx('session-toolbar')}>
              <ToolsetPanel
                toolsets={toolsets}
                enabled={enabled}
                disabled={running}
                onChange={changeToolsets}
              />
              <Button
                variant="secondary"
                size="small"
                onPress={() => setShareOpen(open => !open)}
              >
                Share
              </Button>
            </div>
          )}
          {!shared && shareOpen && (
            <ShareDialog
              api={api}
              sessionId={sessionId}
              shares={shares}
              onSharesChange={setShares}
              onClose={() => setShareOpen(false)}
            />
          )}
          {(toolsetError || shareError) && (
            <div className={cx('chat-error')} role="alert">
              {toolsetError ?? shareError}
            </div>
          )}
          <MessageList
            busy={chat.busy}
            disabled={chat.deciding || Boolean(shared)}
            notice={chat.notice}
            tools={tools}
            decisions={chat.decisions}
            toolResults={toolResults}
            error={chat.error}
            interrupted={!shared && chat.interrupted && chat.canResend}
            onSendAgain={shared ? undefined : chat.sendAgain}
            onSendTextAgain={
              shared || running || chat.busy ? undefined : chat.sendTextAgain
            }
          />
          {!shared && (
            <>
              <ComposerQueue
                queue={queue}
                paused={chat.queuePaused}
                pausedReason={chat.queuePausedReason}
                notice={chat.queueNotice}
                onContinue={chat.continueQueue}
                moving={chat.queueMoving}
                canSendNow={
                  chat.activeRun?.status === 'running' &&
                  !chat.followingNext &&
                  !chat.sendingNow
                }
                maxMessages={queueMax}
              />
              <Composer
                hint={hint}
                placeholder={placeholder}
                sendLabel={waiting ? 'Queue' : undefined}
                canQueue={running && !waiting}
                canStop={running}
                rejections={rejections}
                onRemoveAttachment={attachments?.remove}
              />
            </>
          )}
        </ThreadPrimitive.Root>
      </AttachmentLoaderContext.Provider>
    </AssistantRuntimeProvider>
  );
}

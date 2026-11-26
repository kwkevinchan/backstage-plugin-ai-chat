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

import { useCallback, useMemo, useState } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { aiChatToolResultsApiRef } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import type {
  ChatAttachment,
  ChatPageContext,
  ChatSessionDetail,
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
import { cx } from './styles';
import { ToolsetPanel } from './ToolsetPanel';

/** The limit of the queue until the input config has answered (the default of the backend). */
const DEFAULT_QUEUE_MAX = 5;

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
  onChanged?(): void;
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
            upload: (file, onProgress) =>
              api.uploadAttachment(sessionId, file, file.name, onProgress),
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AttachmentLoaderContext.Provider value={loadAttachment}>
        <ThreadPrimitive.Root className={cx('chat-main')}>
          <ToolsetPanel
            toolsets={toolsets}
            enabled={enabled}
            disabled={running}
            onChange={changeToolsets}
          />
          {toolsetError && (
            <div className={cx('chat-error')} role="alert">
              {toolsetError}
            </div>
          )}
          <MessageList
            busy={chat.busy}
            disabled={chat.deciding}
            notice={chat.notice}
            tools={tools}
            decisions={chat.decisions}
            toolResults={toolResults}
            error={chat.error}
            interrupted={chat.interrupted && chat.canResend}
            onSendAgain={chat.sendAgain}
            onSendTextAgain={
              running || chat.busy ? undefined : chat.sendTextAgain
            }
          />
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
          />
        </ThreadPrimitive.Root>
      </AttachmentLoaderContext.Provider>
    </AssistantRuntimeProvider>
  );
}

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

import { useCallback, useState } from 'react';
import type {
  ChatSessionDetail,
  ChatToolset,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import { describeError } from '../adapters/describeError';
import { useSessionChat } from '../application/useSessionChat';
import { useSessionTools } from '../application/useSessionTools';
import { usePageContext } from '../application/usePageContext';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { PendingInserts } from './PendingInserts';
import { QueuePanel } from './QueuePanel';
import { cx } from './styles';
import { ToolsetPanel } from './ToolsetPanel';

export interface SessionViewProps {
  api: AiChatApi;
  detail: ChatSessionDetail;
  toolsets: ChatToolset[];
  /** The message to send when the session opens, for a session just created. */
  firstMessage?: string;
  onChanged?(): void;
}

/** One session: its messages, the toolsets, the input box. Keyed by the session. */
export function SessionView(props: SessionViewProps) {
  const { api, detail, toolsets } = props;
  const page = usePageContext();
  const chat = useSessionChat({
    api,
    detail,
    page,
    firstMessage: props.firstMessage,
    onChanged: props.onChanged,
  });
  const [enabled, setEnabled] = useState(detail.session.enabledToolsets);
  const tools = useSessionTools(api, detail.session.id, enabled.join(','));
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
    <div className={cx('chat-main')}>
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
        messages={chat.messages}
        busy={chat.busy}
        disabled={chat.deciding}
        notice={chat.notice}
        tools={tools}
        decisions={chat.decisions}
        error={chat.error}
        interrupted={chat.interrupted && chat.canResend}
        onDecide={chat.decide}
        onSendAgain={chat.sendAgain}
        onSendTextAgain={chat.sendTextAgain}
      />
      <QueuePanel
        items={chat.queue}
        paused={chat.queuePaused}
        pausedReason={chat.queuePausedReason}
        notice={chat.queueNotice}
        onContinue={chat.continueQueue}
        onEdit={chat.editQueued}
        onRemove={chat.removeQueued}
        onMove={chat.moveQueued}
      />
      <PendingInserts items={chat.pending} />
      <Composer
        onSend={chat.send}
        onQueue={running && !waiting ? chat.queueMessage : undefined}
        sendLabel={waiting ? 'Queue' : undefined}
        disabled={(chat.busy && !running) || chat.followingNext}
        hint={hint}
        placeholder={placeholder}
        onStop={running ? chat.stop : undefined}
      />
    </div>
  );
}

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

import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@backstage/ui';
import { MAX_MESSAGE_LENGTH } from '../common';
import type { ChatMessage, ChatToolCall } from '../common';
import type { ChatState } from './chatState';
import { Markdown } from './Markdown';
import { cx } from './styles';
import { ApprovalCard, ToolCallRow } from './ToolCallView';

export interface ChatViewProps {
  state: ChatState;
  onSend(content: string): void;
  onApprove(toolCall: ChatToolCall): void;
  onReject(toolCall: ChatToolCall): void;
}

/** A call shows as a card when it waited for, or got, a decision. */
function needsCard(call: ChatToolCall) {
  return call.status === 'pending_approval' || Boolean(call.decidedBy);
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className={cx('chat-message', 'chat-message-user')}>
        {message.content}
      </div>
    );
  }
  if (!message.content) return null;
  return (
    <div className={cx('chat-message', 'chat-message-assistant')}>
      <Markdown text={message.content} />
    </div>
  );
}

/** The messages of a conversation with their tool calls, and the input box. */
export function ChatView(props: ChatViewProps) {
  const { state } = props;
  const [draft, setDraft] = useState('');
  const timeline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = timeline.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.toolCalls, state.streamingText]);

  const waiting = state.toolCalls.some(c => c.status === 'pending_approval');
  const callsOf = (messageId: string) =>
    state.toolCalls.filter(c => c.messageId === messageId);

  const submit = () => {
    const content = draft.trim();
    if (!content || state.streaming) return;
    setDraft('');
    props.onSend(content);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const empty = state.messages.length === 0 && !state.streamingText;
  return (
    <div className={cx('chat-main')}>
      <div
        className={cx('chat-timeline')}
        ref={timeline}
        aria-live="polite"
        aria-busy={state.streaming}
      >
        {empty && !state.error && (
          <div className={cx('chat-empty')}>
            Ask a question. The assistant can use the actions of Backstage as
            you. Actions that only read run at once; every action that changes
            something waits for your approval here.
          </div>
        )}
        {state.messages.map(message => (
          <div key={message.id} style={{ display: 'contents' }}>
            <MessageBubble message={message} />
            {callsOf(message.id).map(call =>
              needsCard(call) ? (
                <ApprovalCard
                  key={call.id}
                  toolCall={call}
                  disabled={state.streaming}
                  onApprove={props.onApprove}
                  onReject={props.onReject}
                />
              ) : (
                <ToolCallRow key={call.id} toolCall={call} />
              ),
            )}
          </div>
        ))}
        {state.streamingText && (
          <div className={cx('chat-message', 'chat-message-assistant')}>
            <Markdown text={state.streamingText} />
          </div>
        )}
        {state.notice && (
          <div className={cx('chat-notice')}>{state.notice}</div>
        )}
        {state.error && (
          <div className={cx('chat-error')} role="alert">
            {state.error}
          </div>
        )}
      </div>
      {waiting && (
        <div className={cx('chat-composer-hint')}>
          An action waits for your decision. A new message rejects it.
        </div>
      )}
      <div className={cx('chat-composer')}>
        <textarea
          className={cx('chat-composer-input')}
          aria-label="Message"
          placeholder="Write a message (Enter sends, Shift+Enter starts a new line)"
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          variant="primary"
          isDisabled={state.streaming || !draft.trim()}
          onPress={submit}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

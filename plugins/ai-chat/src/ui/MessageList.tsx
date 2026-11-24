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

import { useEffect, useRef } from 'react';
import { isToolUIPart } from 'ai';
import type { ChatNoticeData } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { ChatUiMessage, ToolPart } from '../domain/types';
import { Markdown } from './Markdown';
import { cx } from './styles';
import { ApprovalCard, needsCard, ToolCallRow } from './ToolCallCard';

/** The text of each notice code, for the screen. */
export const NOTICE_TEXT: Record<ChatNoticeData['code'], string> = {
  summarizing: 'Summarizing the earlier part of the conversation...',
  context_trimmed: 'Earlier content was left out of what the assistant reads.',
};

export interface MessageListProps {
  messages: ChatUiMessage[];
  /** A response is on its way. */
  busy: boolean;
  /** Set while a decision is being sent: the cards cannot be used. */
  disabled: boolean;
  notice?: ChatNoticeData['code'];
  error?: string;
  /** The last run stopped before it gave an answer. */
  interrupted?: boolean;
  onDecide(callId: string, approved: boolean): void;
  onSendAgain?(): void;
}

function MessageParts({
  message,
  disabled,
  onDecide,
}: {
  message: ChatUiMessage;
  disabled: boolean;
  onDecide(callId: string, approved: boolean): void;
}) {
  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}:${index}`;
        if (part.type === 'text') {
          if (!part.text) return null;
          return message.role === 'user' ? (
            <div key={key} className={cx('chat-message', 'chat-message-user')}>
              {part.text}
            </div>
          ) : (
            <div
              key={key}
              className={cx('chat-message', 'chat-message-assistant')}
            >
              <Markdown text={part.text} />
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const tool = part as ToolPart;
          return needsCard(tool) ? (
            <ApprovalCard
              key={tool.toolCallId}
              part={tool}
              disabled={disabled}
              onDecide={onDecide}
            />
          ) : (
            <ToolCallRow key={tool.toolCallId} part={tool} />
          );
        }
        return null;
      })}
    </>
  );
}

/** The messages of a session with their tool calls, and what the run says. */
export function MessageList(props: MessageListProps) {
  const { messages } = props;
  const timeline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = timeline.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  return (
    <div
      className={cx('chat-timeline')}
      ref={timeline}
      aria-live="polite"
      aria-busy={props.busy}
    >
      {messages.length === 0 && !props.error && (
        <div className={cx('chat-empty')}>
          Ask a question. The assistant can use the actions of Backstage as you.
          Actions that only read run at once; every action that changes
          something waits for your approval here.
        </div>
      )}
      {messages.map(message => (
        <div key={message.id} style={{ display: 'contents' }}>
          <MessageParts
            message={message}
            disabled={props.disabled || props.busy}
            onDecide={props.onDecide}
          />
        </div>
      ))}
      {props.notice && (
        <div className={cx('chat-notice')}>{NOTICE_TEXT[props.notice]}</div>
      )}
      {props.interrupted && !props.busy && (
        <div className={cx('chat-notice')} role="status">
          The last run stopped before it gave an answer.
          {props.onSendAgain && (
            <>
              {' '}
              <button type="button" onClick={props.onSendAgain}>
                Send the message again
              </button>
            </>
          )}
        </div>
      )}
      {props.error && (
        <div className={cx('chat-error')} role="alert">
          {props.error}
        </div>
      )}
    </div>
  );
}

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
import type {
  ChatAttachment,
  ChatNoticeData,
  ChatTool,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { DecisionInfo } from '../domain/itemsToMessages';
import { toolIdOf } from '../domain/toolView';
import type { ChatUiMessage, ToolPart } from '../domain/types';
import { AttachmentList } from './AttachmentThumb';
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
  /** The tools of the session by id, and who decided which call. */
  tools?: Record<string, ChatTool>;
  decisions?: Record<string, DecisionInfo>;
  error?: string;
  /** The last run stopped before it gave an answer. */
  interrupted?: boolean;
  onDecide(callId: string, approved: boolean): void;
  /** Sends the first message of the run again (the run gave no answer). */
  onSendAgain?(): void;
  /** Sends a message that the run did not read again. */
  onSendTextAgain?(text: string, attachments?: ChatAttachment[]): void;
  /** Reads one image of the session, with the signed-in request. */
  loadAttachment?(id: string): Promise<Blob>;
}

/** The label of an inserted message that the run ended without reading. */
export const UNREAD_TEXT = 'The agent did not read this message.';

function MessageParts({
  message,
  tools,
  decisions,
  disabled,
  onDecide,
  onSendTextAgain,
  loadAttachment,
}: {
  message: ChatUiMessage;
  tools?: Record<string, ChatTool>;
  decisions?: Record<string, DecisionInfo>;
  disabled: boolean;
  onDecide(callId: string, approved: boolean): void;
  onSendTextAgain?(text: string, attachments?: ChatAttachment[]): void;
  loadAttachment?(id: string): Promise<Blob>;
}) {
  const text = message.parts.find(part => part.type === 'text');
  const attachments = message.metadata?.attachments ?? [];
  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}:${index}`;
        if (part.type === 'text') {
          if (message.role === 'user') {
            const first = message.parts.find(item => item.type === 'text');
            if (first !== part) return null;
            if (!part.text && attachments.length === 0) return null;
            return (
              <div
                key={key}
                className={cx('chat-message', 'chat-message-user')}
              >
                {part.text}
                {attachments.length > 0 && loadAttachment && (
                  <AttachmentList
                    attachments={attachments}
                    load={loadAttachment}
                  />
                )}
              </div>
            );
          }
          if (!part.text) return null;
          return (
            <div
              key={key}
              className={cx('chat-message', 'chat-message-assistant')}
            >
              <Markdown text={part.text} />
            </div>
          );
        }
        if (part.type === 'data-inserted') {
          // A message that the user added to the run, shown where the model
          // read it.
          const inserted = part.data.attachments ?? [];
          if (!part.data.text && inserted.length === 0) return null;
          return (
            <div key={key} className={cx('chat-message', 'chat-message-user')}>
              {part.data.text}
              {inserted.length > 0 && loadAttachment && (
                <AttachmentList attachments={inserted} load={loadAttachment} />
              )}
            </div>
          );
        }
        if (part.type === 'data-unread') {
          const userText = text?.type === 'text' ? text.text : '';
          const canSend =
            text?.type === 'text' &&
            (userText.length > 0 || attachments.length > 0);
          return (
            <div key={key} className={cx('chat-unread')} role="status">
              {UNREAD_TEXT}
              {part.data.sendAgain && onSendTextAgain && canSend && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() =>
                      onSendTextAgain(
                        userText,
                        attachments.length > 0 ? attachments : undefined,
                      )
                    }
                  >
                    Send this message again
                  </button>
                </>
              )}
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const tool = part as ToolPart;
          return needsCard(tool) ? (
            <ApprovalCard
              key={tool.toolCallId}
              part={tool}
              tool={tools?.[toolIdOf(tool)]}
              decision={decisions?.[tool.toolCallId]}
              disabled={disabled}
              onDecide={onDecide}
            />
          ) : (
            <ToolCallRow
              key={tool.toolCallId}
              part={tool}
              tool={tools?.[toolIdOf(tool)]}
            />
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
            tools={props.tools}
            decisions={props.decisions}
            disabled={props.disabled || props.busy}
            onDecide={props.onDecide}
            onSendTextAgain={props.onSendTextAgain}
            loadAttachment={props.loadAttachment}
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

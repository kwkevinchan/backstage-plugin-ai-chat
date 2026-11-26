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

import { createContext, useContext } from 'react';
import {
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type DataMessagePartProps,
  type TextMessagePartProps,
} from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import type {
  ChatAttachment,
  ChatInsertedData,
  ChatNoticeData,
  ChatTool,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatToolResultsApi } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import type { DecisionInfo } from '../domain/itemsToMessages';
import { UPDATE_PLAN_TOOL } from '../domain/plan';
import type { ChatUnreadData } from '../domain/types';
import { chatAttachmentsOf } from '../adapters/assistantUi/attachmentAdapter';
import { ChatImages, messageAttachmentComponents } from './Attachments';
import { MarkdownText } from './MarkdownText';
import { PlanToolCall } from './PlanCard';
import { cx } from './styles';
import { ToolCall, ToolCallViewContext } from './ToolCallCard';

/** The text of each notice code, for the screen. */
export const NOTICE_TEXT: Record<ChatNoticeData['code'], string> = {
  summarizing: 'Summarizing the earlier part of the conversation...',
  context_trimmed: 'Earlier content was left out of what the assistant reads.',
};

/** The label of an inserted message that the run ended without reading. */
export const UNREAD_TEXT = 'The agent did not read this message.';

export const EMPTY_TEXT =
  'Ask a question. The assistant can use the actions of Backstage as you. ' +
  'Actions that only read run at once; every action that changes something ' +
  'waits for your approval here.';

export interface MessageListProps {
  /** A response is on its way. */
  busy: boolean;
  /** Set while a decision is being sent: the cards cannot be used. */
  disabled: boolean;
  notice?: ChatNoticeData['code'];
  /** The tools of the session by id, and who decided which call. */
  tools?: Record<string, ChatTool>;
  decisions?: Record<string, DecisionInfo>;
  /** The result components of the plugins, by action id. */
  toolResults?: AiChatToolResultsApi;
  error?: string;
  /** The last run stopped before it gave an answer. */
  interrupted?: boolean;
  /** Sends the first message of the run again (the run gave no answer). */
  onSendAgain?(): void;
  /** Sends a message that the run did not read again, with its images. */
  onSendTextAgain?(text: string, attachments?: ChatAttachment[]): void;
}

const SendTextAgainContext = createContext<
  ((text: string, attachments?: ChatAttachment[]) => void) | undefined
>(undefined);

function UserText({ text }: TextMessagePartProps) {
  if (!text) return null;
  return <div className={cx('chat-message', 'chat-message-user')}>{text}</div>;
}

function AssistantText({ text }: TextMessagePartProps) {
  if (!text) return null;
  return (
    <div className={cx('chat-message', 'chat-message-assistant')}>
      <MarkdownText />
    </div>
  );
}

/** A message that the user added to the run, shown where the model read it. */
function Inserted({ data }: DataMessagePartProps<ChatInsertedData>) {
  return (
    <>
      {data.text && (
        <div className={cx('chat-message', 'chat-message-user')}>
          {data.text}
        </div>
      )}
      <ChatImages
        attachments={data.attachments ?? []}
        className="chat-message-images"
      />
    </>
  );
}

/** An inserted message that the run ended without reading, and its button. */
function Unread({ data }: DataMessagePartProps<ChatUnreadData>) {
  const onSendTextAgain = useContext(SendTextAgainContext);
  const text = useAuiState(s => {
    const part = s.message.parts.find(p => p.type === 'text');
    return part?.type === 'text' ? part.text : undefined;
  });
  const attachments = useAuiState(s => s.message.attachments);
  return (
    <div className={cx('chat-unread')} role="status">
      {UNREAD_TEXT}
      {data.sendAgain && onSendTextAgain && text !== undefined && (
        <>
          {' '}
          <Button
            size="small"
            variant="tertiary"
            onPress={() => {
              const images = chatAttachmentsOf(attachments);
              onSendTextAgain(text, images.length > 0 ? images : undefined);
            }}
          >
            Send this message again
          </Button>
        </>
      )}
    </div>
  );
}

// The run, the notices and the other data parts are shown outside the
// messages or not at all. The plan is shown with its `update_plan` call.
const Hidden = () => null;

const data = {
  by_name: { inserted: Inserted, unread: Unread },
  Fallback: Hidden,
};

function UserMessage() {
  return (
    <MessagePrimitive.Root style={{ display: 'contents' }}>
      <AuiIf condition={s => (s.message.attachments?.length ?? 0) > 0}>
        <ul className={cx('chat-images', 'chat-message-images')}>
          <MessagePrimitive.Attachments
            components={messageAttachmentComponents}
          />
        </ul>
      </AuiIf>
      <MessagePrimitive.Parts components={{ Text: UserText, data }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root style={{ display: 'contents' }}>
      <MessagePrimitive.Parts
        components={{
          Text: AssistantText,
          data,
          tools: {
            by_name: { [UPDATE_PLAN_TOOL]: PlanToolCall },
            Fallback: ToolCall,
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

const messageComponents = { UserMessage, AssistantMessage };

/**
 * The messages of the session with their tool calls, and what the run says,
 * in the viewport of assistant-ui, which follows new content while the view
 * is at the end.
 */
export function MessageList(props: MessageListProps) {
  const empty = useAuiState(s => s.thread.messages.length === 0);
  return (
    <ToolCallViewContext.Provider
      value={{
        tools: props.tools,
        decisions: props.decisions,
        disabled: props.disabled || props.busy,
        toolResults: props.toolResults,
      }}
    >
      <SendTextAgainContext.Provider value={props.onSendTextAgain}>
        <ThreadPrimitive.Viewport
          className={cx('chat-timeline')}
          aria-live="polite"
          aria-busy={props.busy}
        >
          {empty && !props.error && (
            <div className={cx('chat-empty')}>{EMPTY_TEXT}</div>
          )}
          <ThreadPrimitive.Messages components={messageComponents} />
          {props.notice && (
            <div className={cx('chat-notice')}>{NOTICE_TEXT[props.notice]}</div>
          )}
          {props.interrupted && !props.busy && (
            <div className={cx('chat-notice')} role="status">
              The last run stopped before it gave an answer.
              {props.onSendAgain && (
                <>
                  {' '}
                  <Button
                    size="small"
                    variant="tertiary"
                    onPress={props.onSendAgain}
                  >
                    Send the message again
                  </Button>
                </>
              )}
            </div>
          )}
          {props.error && (
            <div className={cx('chat-error')} role="alert">
              {props.error}
            </div>
          )}
        </ThreadPrimitive.Viewport>
      </SendTextAgainContext.Provider>
    </ToolCallViewContext.Provider>
  );
}

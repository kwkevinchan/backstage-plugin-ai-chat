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

import { Content, Header, Page } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react';
import { Button, Container } from '@backstage/ui';
import { aiChatApiRef } from '../api';
import { ChatView } from './ChatView';
import { cx } from './styles';
import { useChat } from './useChat';

/** The conversation list, the open conversation and the input box. */
export function ChatPageContent() {
  const api = useApi(aiChatApiRef);
  const chat = useChat(api);

  return (
    <div className={cx('chat-layout')}>
      <nav className={cx('chat-sidebar')} aria-label="Conversations">
        <Button
          variant="secondary"
          iconStart={<RiAddLine size="1em" />}
          onPress={() => chat.select(undefined)}
        >
          New chat
        </Button>
        {chat.listError && (
          <div className={cx('chat-error')} role="alert">
            {chat.listError}
          </div>
        )}
        {chat.conversations.map(conversation => (
          <div
            key={conversation.id}
            className={cx(
              'chat-conversation',
              conversation.id === chat.conversationId &&
                'chat-conversation-selected',
            )}
          >
            <button
              type="button"
              className={cx('chat-conversation-open')}
              aria-current={conversation.id === chat.conversationId}
              onClick={() => chat.select(conversation.id)}
            >
              {conversation.title}
            </button>
            <button
              type="button"
              className={cx('chat-icon-button')}
              aria-label={`Delete conversation ${conversation.title}`}
              onClick={() => chat.remove(conversation.id)}
            >
              <RiDeleteBinLine size="1em" />
            </button>
          </div>
        ))}
      </nav>
      <ChatView
        state={chat.state}
        onSend={chat.send}
        onApprove={chat.approve}
        onReject={chat.reject}
      />
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

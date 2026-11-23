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

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { describeError } from '../api';
import type { AiChatApi } from '../api';
import type { ChatConversation, ChatEvent, ChatToolCall } from '../common';
import { chatReducer, emptyChatState } from './chatState';

/** The state and the actions of the chat page. */
export function useChat(api: AiChatApi) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [state, dispatch] = useReducer(chatReducer, emptyChatState);
  const [listError, setListError] = useState<string>();
  const abort = useRef<AbortController>();
  /** A conversation that this hook just created: its state is already here. */
  const createdHere = useRef<string>();

  const refreshList = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
      setListError(undefined);
    } catch (error) {
      setListError(describeError(error));
    }
  }, [api]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!conversationId) {
      dispatch({ type: 'reset' });
      return undefined;
    }
    if (createdHere.current === conversationId) {
      createdHere.current = undefined;
      return undefined;
    }
    let cancelled = false;
    api
      .getConversation(conversationId)
      .then(detail => {
        if (!cancelled) dispatch({ type: 'loaded', detail });
      })
      .catch(error => {
        if (!cancelled) {
          dispatch({
            type: 'failed',
            message: describeError(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, conversationId]);

  const consume = useCallback(
    async (open: (signal: AbortSignal) => AsyncIterable<ChatEvent>) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      dispatch({ type: 'streamStarted' });
      try {
        for await (const event of open(controller.signal)) {
          dispatch({ type: 'event', event });
        }
        dispatch({ type: 'streamEnded' });
      } catch (error) {
        if (controller.signal.aborted) return;
        dispatch({
          type: 'failed',
          message: describeError(error),
        });
      } finally {
        refreshList();
      }
    },
    [refreshList],
  );

  const send = useCallback(
    async (content: string) => {
      let id = conversationId;
      if (!id) {
        try {
          const created = await api.createConversation();
          id = created.id;
          createdHere.current = id;
          setConversationId(id);
        } catch (error) {
          dispatch({
            type: 'failed',
            message: describeError(error),
          });
          return;
        }
      }
      const target = id;
      await consume(signal => api.sendMessage(target, content, signal));
    },
    [api, consume, conversationId],
  );

  const decide = useCallback(
    async (call: ChatToolCall, decision: 'approve' | 'reject') => {
      if (!conversationId) return;
      await consume(signal =>
        decision === 'approve'
          ? api.approveToolCall(conversationId, call.id, signal)
          : api.rejectToolCall(conversationId, call.id, signal),
      );
    },
    [api, consume, conversationId],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        if (id === conversationId) setConversationId(undefined);
        await refreshList();
      } catch (error) {
        setListError(describeError(error));
      }
    },
    [api, conversationId, refreshList],
  );

  const select = useCallback((id: string | undefined) => {
    abort.current?.abort();
    createdHere.current = undefined;
    setConversationId(id);
  }, []);

  return {
    conversations,
    conversationId,
    state,
    listError,
    select,
    send,
    approve: (call: ChatToolCall) => decide(call, 'approve'),
    reject: (call: ChatToolCall) => decide(call, 'reject'),
    remove,
  };
}

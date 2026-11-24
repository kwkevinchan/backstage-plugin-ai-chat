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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import type {
  ChatNoticeData,
  ChatPageContext,
  ChatRun,
  ChatRunStatus,
  ChatSessionDetail,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import {
  AiChatTransport,
  type ChatRequestBody,
} from '../adapters/AiChatTransport';
import { describeError } from '../adapters/describeError';
import {
  awaitingCalls,
  decidedCalls,
  isLastDecision,
} from '../domain/approval';
import {
  decisionsOf,
  itemsToMessages,
  lastRunInterrupted,
  lastUserText,
} from '../domain/itemsToMessages';
import type { ChatUiMessage } from '../domain/types';

export interface UseSessionChatOptions {
  api: AiChatApi;
  detail: ChatSessionDetail;
  /** The page the user is on; sent with every message. */
  page: ChatPageContext;
  /** A message to send when the screen opens (the first message of a new session). */
  firstMessage?: string;
  /** Called after a run changed the session (a title, the order of the list). */
  onChanged?(): void;
}

const ENDED_WITHOUT_ANSWER: ChatRunStatus[] = [
  'failed',
  'cancelled',
  'expired',
];

const EVENT_STREAM = 'text/event-stream';

/**
 * The chat of one session: `useChat` with the transport of the backend, the
 * messages restored from the log, and the rules around it. Create it for one
 * session only (give the component the session id as its key).
 *
 * - The decisions: every Allow or Deny is stored at once. The last one that
 *   the run waits for is sent through the chat (the response is the stream of
 *   the run); any other goes straight to the backend.
 * - Opening a session follows a run that goes on, and carries on a run whose
 *   decisions are all stored. After a decision made here nothing carries on by
 *   itself: the response of that decision does it.
 */
export function useSessionChat(options: UseSessionChatOptions) {
  const { api, onChanged } = options;
  const sessionId = options.detail.session.id;
  const [initial] = useState(() => ({
    detail: options.detail,
    messages: itemsToMessages(options.detail),
  }));
  const pageRef = useRef(options.page);
  pageRef.current = options.page;
  const pendingDecision = useRef<{ callId: string; approved: boolean }>();
  /** The run goes on without this request: follow it when the request ends. */
  const followAfter = useRef(false);
  const lastRunStatus = useRef<ChatRunStatus>();
  const [activeRun, setActiveRun] = useState<ChatRun | undefined>(
    initial.detail.run,
  );
  const [interrupted, setInterrupted] = useState(() =>
    lastRunInterrupted(initial.detail),
  );
  const [resendText, setResendText] = useState(() =>
    lastUserText(initial.detail.items),
  );
  const [notice, setNotice] = useState<ChatNoticeData['code']>();
  const [failure, setFailure] = useState<string>();
  const [decisions, setDecisions] = useState(() =>
    decisionsOf(initial.detail.items),
  );
  const askedForDecisions = useRef(new Set<string>());
  const [deciding, setDeciding] = useState(false);
  const decidingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const transport = useMemo(
    () =>
      new AiChatTransport({
        api,
        sessionId,
        getPage: () => pageRef.current,
        onDecisionTaken: () => {
          pendingDecision.current = undefined;
        },
        onDecisionStored: () => {
          followAfter.current = true;
        },
        onNothingToResume: () => {
          followAfter.current = true;
        },
      }),
    [api, sessionId],
  );

  const chat = useChat<ChatUiMessage>({
    id: sessionId,
    messages: initial.messages,
    transport,
    resume:
      initial.detail.run?.status === 'running' && !initial.detail.resumable,
    sendAutomaticallyWhen: ({ messages }) =>
      pendingDecision.current !== undefined &&
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),
    onData: part => {
      if (part.type === 'data-run') {
        const { runId, status } = part.data;
        lastRunStatus.current = status;
        setActiveRun(current =>
          status === 'running' || status === 'waiting_approval'
            ? {
                cancelRequested: false,
                startedAt: new Date().toISOString(),
                ...(current?.id === runId ? current : undefined),
                id: runId,
                sessionId,
                status,
              }
            : undefined,
        );
      } else if (part.type === 'data-notice') {
        setNotice(part.data.code);
      }
    },
    onError: error => {
      pendingDecision.current = undefined;
      setFailure(describeError(error));
    },
  });
  const chatRef = useRef(chat);
  chatRef.current = chat;

  /**
   * A request of this page that failed (the backend shut down, say) after the
   * last decision was stored: the loop did not start, and no other request
   * took it over. One try to carry it on, until the user acts again.
   */
  const carryOnTried = useRef(false);

  /**
   * Reads the session again and shows what is stored. With `carryOn`, a run
   * that is left with all its decisions stored is carried on, once: the request
   * that failed is this page's own, so no other request has taken it over.
   */
  const reload = useCallback(
    async (opts?: { carryOn?: boolean }) => {
      try {
        const detail = await api.getSession(sessionId);
        if (!mounted.current) return;
        chatRef.current.setMessages(itemsToMessages(detail));
        setActiveRun(detail.run);
        setInterrupted(lastRunInterrupted(detail));
        setResendText(lastUserText(detail.items));
        setDecisions(decisionsOf(detail.items));
        if (opts?.carryOn && detail.resumable && !carryOnTried.current) {
          carryOnTried.current = true;
          const body: ChatRequestBody = { resume: true };
          chatRef.current.sendMessage(undefined, { body });
        }
      } catch (error) {
        if (mounted.current) setFailure(describeError(error));
      }
    },
    [api, sessionId],
  );

  // A request has ended: follow the run that goes on, or show what is stored
  // when the stream did not end with the answer.
  const { status } = chat;
  useEffect(() => {
    if (status === 'submitted') {
      setNotice(undefined);
      return;
    }
    if (status !== 'ready' && status !== 'error') return;
    onChanged?.();
    // A decision made on this page is known to the log, not to the stream:
    // read who decided it and when.
    const missing = decidedCalls(chatRef.current.messages).filter(
      id => !decisions[id] && !askedForDecisions.current.has(id),
    );
    if (missing.length > 0) {
      missing.forEach(id => askedForDecisions.current.add(id));
      api
        .getSession(sessionId)
        .then(detail => {
          if (mounted.current) setDecisions(decisionsOf(detail.items));
        })
        .catch(() => {
          // The cards show the result without who decided it.
        });
    }
    if (followAfter.current) {
      followAfter.current = false;
      chatRef.current.resumeStream().then(
        () => reload(),
        () => reload(),
      );
    } else if (
      status === 'error' ||
      (lastRunStatus.current &&
        ENDED_WITHOUT_ANSWER.includes(lastRunStatus.current))
    ) {
      lastRunStatus.current = undefined;
      reload({ carryOn: status === 'error' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Opening the session: carry on a run whose decisions are all stored, or
  // send the first message of a new session. Once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial.detail.resumable) {
      const body: ChatRequestBody = { resume: true };
      chatRef.current.sendMessage(undefined, { body });
    } else if (options.firstMessage) {
      chatRef.current.sendMessage({ text: options.firstMessage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(async (text: string) => {
    carryOnTried.current = false;
    setFailure(undefined);
    setInterrupted(false);
    setResendText(text);
    await chatRef.current.sendMessage({ text });
  }, []);

  const sendAgain = useCallback(async () => {
    if (resendText) await send(resendText);
  }, [resendText, send]);

  const decide = useCallback(
    async (callId: string, approved: boolean) => {
      if (decidingRef.current) return;
      decidingRef.current = true;
      carryOnTried.current = false;
      setDeciding(true);
      setFailure(undefined);
      try {
        if (isLastDecision(chatRef.current.messages, callId)) {
          pendingDecision.current = { callId, approved };
          const body: ChatRequestBody = { callId, approved };
          await chatRef.current.addToolApprovalResponse({
            id: callId,
            approved,
            options: { body },
          });
        } else {
          const response = await api.decide(sessionId, callId, {
            approved,
            page: pageRef.current,
          });
          // A stream here means the request stored the last decision after
          // all (another tab decided the other calls). The loop runs; follow
          // it through the chat, and not through this body.
          const carriesOn = (
            response.headers.get('content-type') ?? ''
          ).includes(EVENT_STREAM);
          await response.body?.cancel();
          await chatRef.current.addToolApprovalResponse({
            id: callId,
            approved,
          });
          if (carriesOn)
            chatRef.current.resumeStream().then(
              () => reload(),
              () => reload(),
            );
        }
      } catch (error) {
        pendingDecision.current = undefined;
        setFailure(describeError(error));
        await reload({ carryOn: true });
      } finally {
        decidingRef.current = false;
        if (mounted.current) setDeciding(false);
      }
    },
    [api, reload, sessionId],
  );

  const stop = useCallback(async () => {
    const run = activeRun;
    if (!run) return;
    try {
      await api.cancelRun(sessionId, run.id);
    } catch (error) {
      setFailure(describeError(error));
      await chatRef.current.stop();
      return;
    }
    // A stream that is open ends with the run. With none open (the run waited
    // for a decision) nothing else tells the screen.
    const current = chatRef.current.status;
    if (current !== 'streaming' && current !== 'submitted') await reload();
  }, [activeRun, api, reload, sessionId]);

  const messages = chat.messages;
  const awaiting = useMemo(() => awaitingCalls(messages), [messages]);

  return {
    messages,
    busy: chat.status === 'submitted' || chat.status === 'streaming',
    activeRun,
    awaiting,
    decisions,
    deciding,
    notice,
    interrupted,
    canResend: Boolean(resendText),
    error: failure ?? (chat.error ? describeError(chat.error) : undefined),
    send,
    sendAgain,
    decide,
    stop,
  };
}

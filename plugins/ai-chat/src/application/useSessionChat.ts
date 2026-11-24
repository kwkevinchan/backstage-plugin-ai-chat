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
  ChatQueue,
  ChatQueuePausedReason,
  ChatRun,
  ChatRunStatus,
  ChatSessionDetail,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import {
  AiChatTransport,
  type ChatRequestBody,
} from '../adapters/AiChatTransport';
import {
  describeError,
  errorNameOf,
  statusOf,
} from '../adapters/describeError';
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
  pendingInserts,
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

/** The queue of the session, and why it is paused when the stream said so. */
type QueueState = ChatQueue & { pausedReason?: ChatQueuePausedReason };

/** What the screen says when a change of the queue found it changed. */
export const QUEUE_CHANGED_TEXT =
  'The queue was changed somewhere else. It is up to date now.';
export const QUEUED_GONE_TEXT = 'That message was sent or removed already.';
export const QUEUE_FULL_TEXT =
  'The queue is full. Delete a queued message, or wait until one is sent.';
export const RUN_CANNOT_TAKE_TEXT =
  'The run could not take the message. Send it again when the run has ended.';

/** The time that a direct send waits for the stream of an ended run to close. */
const IDLE_WAIT_MS = 3000;

/**
 * The chat of one session: `useChat` with the transport of the backend, the
 * messages restored from the log, and the rules around it. Create it for one
 * session only (give the component the session id as its key).
 *
 * - The decisions: every Allow or Deny is stored at once. The last one that
 *   the run waits for is sent through the chat (the response is the stream of
 *   the run); any other goes straight to the backend.
 * - A message written while a run goes on is inserted into the run (Enter)
 *   or queued (Ctrl or Cmd with Enter; the only way while the run waits for a
 *   decision). Neither goes through `useChat`: its stream of the run is open
 *   already. A refused insert is read again and then queued, inserted into
 *   the new run, or sent as a new message (architecture, "frontend").
 * - The queue: the stream tells its state when a run ends (`data-queue`);
 *   when it started the next run, the screen follows that run.
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
  /** The run that the queue started: follow it when the stream ends. */
  const nextRun = useRef<string>();
  /** The stream of that run has told its state. */
  const nextRunSeen = useRef(false);
  const [activeRun, setActiveRun] = useState<ChatRun | undefined>(
    initial.detail.run,
  );
  const [interrupted, setInterrupted] = useState(() =>
    lastRunInterrupted(initial.detail),
  );
  const [resendText, setResendText] = useState(() =>
    lastUserText(initial.detail.items),
  );
  const [pending, setPending] = useState(() => pendingInserts(initial.detail));
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** The inserted messages that the stream said the model read. */
  const readSeqs = useRef(new Set<number>());
  const [queue, setQueue] = useState<QueueState>(initial.detail.queue);
  const [queueNotice, setQueueNotice] = useState<string>();
  /** The run that the queue started and this page is about to follow. */
  const [followingNext, setFollowingNext] = useState<string>();
  const followingNextRef = useRef<string>();
  followingNextRef.current = followingNext;
  /** The run that ended had messages that were not read: read the session again. */
  const reloadAfterEnd = useRef(false);
  const [notice, setNotice] = useState<ChatNoticeData['code']>();
  const [failure, setFailure] = useState<string>();
  const [decisions, setDecisions] = useState(() =>
    decisionsOf(initial.detail.items),
  );
  const askedForDecisions = useRef(new Set<string>());
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;
  const [deciding, setDeciding] = useState(false);
  const decidingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyQueue = useCallback(
    (next: ChatQueue) =>
      setQueue(current => ({
        items: next.items,
        paused: next.paused,
        // A read does not know the reason; the stream did.
        ...(next.paused &&
          current.pausedReason && { pausedReason: current.pausedReason }),
      })),
    [],
  );

  /** Reads the queue again: what a run that ended or another tab did to it. */
  const refreshQueue = useCallback(async () => {
    try {
      const next = await api.getQueue(sessionId);
      if (mounted.current) applyQueue(next);
    } catch {
      // The queue shows what it showed.
    }
  }, [api, applyQueue, sessionId]);
  const refreshQueueRef = useRef(refreshQueue);
  refreshQueueRef.current = refreshQueue;

  // Another tab may have changed the queue.
  useEffect(() => {
    const onFocus = () => refreshQueueRef.current();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
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
        if (runId === followingNextRef.current) {
          nextRunSeen.current = true;
          setFollowingNext(undefined);
        }
        if (
          status === 'running' &&
          activeRunRef.current?.id !== runId &&
          !followingNextRef.current
        ) {
          // A run began (this page's message, or the queue's): the queue
          // changed with it.
          refreshQueueRef.current();
        }
        if (
          status !== 'running' &&
          status !== 'waiting_approval' &&
          pendingRef.current.length > 0
        ) {
          reloadAfterEnd.current = true;
        }
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
      } else if (part.type === 'data-inserted') {
        readSeqs.current.add(part.data.seq);
        setPending(current => current.filter(m => m.seq !== part.data.seq));
      } else if (part.type === 'data-queue') {
        const { nextRunId, ...next } = part.data;
        setQueue(next);
        setQueueNotice(undefined);
        if (nextRunId) {
          nextRun.current = nextRunId;
          setFollowingNext(nextRunId);
        }
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
        applyQueue(detail.queue);
        setPending(pendingInserts(detail));
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
    [api, applyQueue, sessionId],
  );

  /**
   * The queue started the next run on this backend: read the session, which
   * has its message and the queue without it, and follow the run from its
   * first item. The stream of the run before has ended.
   */
  const followNextRun = async () => {
    nextRunSeen.current = false;
    try {
      await reload();
      await chatRef.current.resumeStream();
    } finally {
      if (mounted.current) setFollowingNext(undefined);
    }
    // Nothing streamed (the run was over already): show what is stored.
    if (!nextRunSeen.current && !nextRun.current) await reload();
  };

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
    if (nextRun.current) {
      // The queue started a run: show its message, and follow it.
      nextRun.current = undefined;
      followNextRun();
    } else if (followAfter.current) {
      followAfter.current = false;
      chatRef.current.resumeStream().then(
        () => reload(),
        () => reload(),
      );
    } else if (
      status === 'error' ||
      reloadAfterEnd.current ||
      (lastRunStatus.current &&
        ENDED_WITHOUT_ANSWER.includes(lastRunStatus.current))
    ) {
      lastRunStatus.current = undefined;
      reloadAfterEnd.current = false;
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

  /** Waits for the stream of a run that ended to close; `sendMessage` needs it. */
  const waitUntilIdle = useCallback(async () => {
    const until = Date.now() + IDLE_WAIT_MS;
    while (
      Date.now() < until &&
      (chatRef.current.status === 'streaming' ||
        chatRef.current.status === 'submitted')
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, []);

  /** Starts a run with the text (no run goes on). */
  const sendDirect = useCallback(
    async (text: string): Promise<boolean> => {
      carryOnTried.current = false;
      setFailure(undefined);
      setQueueNotice(undefined);
      setInterrupted(false);
      setResendText(text);
      await waitUntilIdle();
      await chatRef.current.sendMessage({ text });
      return true;
    },
    [waitUntilIdle],
  );

  /** Queues the text. A queue that cannot take it leaves the text with the user (`false`). */
  const queueText = useCallback(
    async (text: string): Promise<boolean> => {
      setFailure(undefined);
      setQueueNotice(undefined);
      try {
        const item = await api.queueMessage(sessionId, {
          text,
          page: pageRef.current,
        });
        setQueue(current => ({
          ...current,
          items: [...current.items.filter(m => m.id !== item.id), item],
        }));
        return true;
      } catch (error) {
        const name = errorNameOf(error);
        if (name === 'NoActiveRun') {
          // The run ended before the message got there: nothing to wait for.
          await refreshQueue();
          setActiveRun(undefined);
          return sendDirect(text);
        }
        if (name === 'QueueFull') {
          await refreshQueue();
          setFailure(QUEUE_FULL_TEXT);
        } else {
          setFailure(describeError(error));
        }
        return false;
      }
    },
    [api, refreshQueue, sendDirect, sessionId],
  );

  /**
   * Inserts the text into the run. A 409 means that the run is not what the
   * screen thought: read the session, and take the way that fits.
   */
  const insertText = useCallback(
    async (runId: string, text: string, retry = true): Promise<boolean> => {
      setFailure(undefined);
      setQueueNotice(undefined);
      try {
        const item = await api.insertMessage(sessionId, runId, {
          text,
          page: pageRef.current,
        });
        // The stream may have said the model read it before this answer came.
        if (!readSeqs.current.has(item.seq)) {
          setPending(current => [...current, { seq: item.seq, text }]);
        }
        return true;
      } catch (error) {
        if (statusOf(error) !== 409) {
          setFailure(describeError(error));
          return false;
        }
        let detail: ChatSessionDetail;
        try {
          detail = await api.getSession(sessionId);
        } catch (reading) {
          setFailure(describeError(reading));
          return false;
        }
        if (!mounted.current) return false;
        setActiveRun(detail.run);
        applyQueue(detail.queue);
        setPending(pendingInserts(detail));
        const current = detail.run;
        if (
          errorNameOf(error) === 'InsertLimitReached' ||
          current?.status === 'waiting_approval'
        ) {
          return queueText(text);
        }
        if (current?.status === 'running' && current.id !== runId && retry) {
          return insertText(current.id, text, false);
        }
        if (!current) return sendDirect(text);
        setFailure(RUN_CANNOT_TAKE_TEXT);
        return false;
      }
    },
    [api, applyQueue, queueText, sendDirect, sessionId],
  );

  /**
   * The text of the box with Enter: a new run when none goes on, an insert
   * into the run, or, while the run waits for a decision, the queue.
   * Resolves with `false` when the text was not taken.
   */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const run = activeRunRef.current;
      if (!run) return sendDirect(text);
      if (run.status === 'waiting_approval') return queueText(text);
      return insertText(run.id, text);
    },
    [insertText, queueText, sendDirect],
  );

  /** The text with Ctrl or Cmd and Enter, or the Queue button. */
  const queueMessage = useCallback(
    async (text: string): Promise<boolean> =>
      activeRunRef.current ? queueText(text) : sendDirect(text),
    [queueText, sendDirect],
  );

  const sendAgain = useCallback(async () => {
    if (resendText) await sendDirect(resendText);
  }, [resendText, sendDirect]);

  /** Shows what a change of the queue found, and reads the queue again. */
  const queueChangeFailed = useCallback(
    async (error: unknown) => {
      const name = errorNameOf(error);
      if (name === 'QueuedMessageNotFound') setQueueNotice(QUEUED_GONE_TEXT);
      else if (name === 'QueueChanged') setQueueNotice(QUEUE_CHANGED_TEXT);
      else setFailure(describeError(error));
      await refreshQueue();
    },
    [refreshQueue],
  );

  const editQueued = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      setQueueNotice(undefined);
      try {
        const item = await api.updateQueuedMessage(sessionId, id, { text });
        setQueue(current => ({
          ...current,
          items: current.items.map(m => (m.id === id ? item : m)),
        }));
        return true;
      } catch (error) {
        await queueChangeFailed(error);
        return false;
      }
    },
    [api, queueChangeFailed, sessionId],
  );

  const removeQueued = useCallback(
    async (id: string) => {
      setQueueNotice(undefined);
      try {
        await api.deleteQueuedMessage(sessionId, id);
        setQueue(current => ({
          ...current,
          items: current.items.filter(m => m.id !== id),
        }));
      } catch (error) {
        await queueChangeFailed(error);
      }
    },
    [api, queueChangeFailed, sessionId],
  );

  const moveQueued = useCallback(
    async (id: string, direction: -1 | 1) => {
      setQueueNotice(undefined);
      const ids = queue.items.map(m => m.id);
      const from = ids.indexOf(id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      try {
        applyQueue(await api.reorderQueue(sessionId, { ids }));
      } catch (error) {
        await queueChangeFailed(error);
      }
    },
    [api, applyQueue, queue.items, queueChangeFailed, sessionId],
  );

  /** Sends the first queued message as a new run (the queue is paused). */
  const continueQueue = useCallback(async () => {
    carryOnTried.current = false;
    setFailure(undefined);
    setQueueNotice(undefined);
    await waitUntilIdle();
    const body: ChatRequestBody = { resumeQueue: true };
    await chatRef.current.sendMessage(undefined, { body });
  }, [waitUntilIdle]);

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
    pending,
    queue: queue.items,
    /** The queue waits for the user: no run goes on, and none is about to start. */
    queuePaused:
      queue.paused && queue.items.length > 0 && !activeRun && !followingNext,
    queuePausedReason: queue.pausedReason,
    queueNotice,
    /** The queue started a run that this page is about to follow. */
    followingNext: Boolean(followingNext),
    send,
    queueMessage,
    sendAgain,
    sendTextAgain: sendDirect,
    editQueued,
    removeQueued,
    moveQueued,
    continueQueue,
    decide,
    stop,
  };
}

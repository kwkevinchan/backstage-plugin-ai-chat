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
  ChatAttachment,
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
  lastUserDraft,
  pendingInserts,
} from '../domain/itemsToMessages';
import type { ChatUiMessage, OutgoingMessage } from '../domain/types';

export interface UseSessionChatOptions {
  api: AiChatApi;
  detail: ChatSessionDetail;
  /** The page the user is on; sent with every message. */
  page: ChatPageContext;
  /** A message to send when the screen opens (the first message of a new session). */
  firstMessage?: string;
  /** Images of that first message. An image with no text is still sent. */
  firstAttachments?: ChatAttachment[];
  /** Called after a run changed the session (a title, the order of the list). */
  onChanged?(): void;
  /**
   * The activity of this session from the list (B-05). A change to `running`
   * while this view is not streaming follows the run. A run that was active
   * and is gone is read again, so a new reply shows up.
   */
  liveActivity?: 'running' | 'waiting_approval';
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
export const RUN_NOT_RUNNING_TEXT =
  'The run is not running any more. The queue is up to date now.';
export const INSERT_LIMIT_TEXT =
  'The run takes no more messages. This one stays in the queue.';

/** The time that a direct send waits for the stream of an ended run to close. */
const IDLE_WAIT_MS = 3000;

function draftOf(input: string | OutgoingMessage): OutgoingMessage {
  return typeof input === 'string' ? { text: input } : input;
}

/** The body of send, insert and queue. Image ids are omitted when there are none. */
function messageBody(draft: OutgoingMessage, page: ChatPageContext) {
  const attachmentIds = draft.attachments?.map(attachment => attachment.id);
  return {
    text: draft.text,
    page,
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
  };
}

function hasContent(draft: OutgoingMessage | undefined): boolean {
  return Boolean(
    draft &&
      (draft.text.length > 0 ||
        (draft.attachments && draft.attachments.length > 0)),
  );
}

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
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
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
  /** The run id whose start already triggered `onChanged`. */
  const startedRunNotified = useRef<string>();
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
  const [resendDraft, setResendDraft] = useState(() =>
    lastUserDraft(initial.detail.items),
  );
  const [pending, setPending] = useState(() => pendingInserts(initial.detail));
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** The inserted messages that the stream said the model read. */
  const readSeqs = useRef(new Set<number>());
  const [queue, setQueue] = useState<QueueState>(initial.detail.queue);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const movingRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const [queueNotice, setQueueNotice] = useState<string>();
  /** A "send now" is on its way: one at a time. */
  const sendingNowRef = useRef(false);
  const [sendingNow, setSendingNow] = useState(false);
  /** The run that the queue started and this page is about to follow. */
  const [followingNext, setFollowingNext] = useState<string>();
  const followingNextRef = useRef<string>();
  /** Sets both at once: the stream says it several times before a render. */
  const following = useCallback((runId: string | undefined) => {
    followingNextRef.current = runId;
    setFollowingNext(runId);
  }, []);
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
    (next: ChatQueue, keepReason = false) =>
      setQueue(current => ({
        items: next.items,
        paused: next.paused,
        // A read does not know the reason; only the stream of this page
        // does. Another tab may have changed the queue since, so a read that
        // is not part of this page's own flow drops it.
        ...(keepReason &&
          next.paused &&
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

  const openedRunning = useRef(initial.detail.run?.status === 'running');

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
        onNoStreamToFollow: () => {
          openedRunning.current = false;
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
          following(undefined);
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
        if (status === 'running' && startedRunNotified.current !== runId) {
          startedRunNotified.current = runId;
          onChangedRef.current?.();
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
          following(nextRunId);
        }
      }
    },
    onFinish: () => {
      openedRunning.current = false;
    },
    onError: error => {
      openedRunning.current = false;
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
        applyQueue(detail.queue, true);
        setPending(pendingInserts(detail));
        setInterrupted(lastRunInterrupted(detail));
        setResendDraft(lastUserDraft(detail.items));
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
  const followNextRun = async (runId: string) => {
    nextRunSeen.current = false;
    try {
      await reload();
      await chatRef.current.resumeStream();
    } finally {
      // The stream of this run may have named the next one: keep that.
      if (mounted.current && followingNextRef.current === runId) {
        following(undefined);
      }
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
      const runId = nextRun.current;
      nextRun.current = undefined;
      followNextRun(runId);
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

  // The list says this session's run changed, and this view is not already
  // on its stream. The first value is the run we opened on: `useChat` follows
  // that one itself.
  const liveActivity = options.liveActivity;
  const sawActivity = useRef(false);
  const activityBefore = useRef(liveActivity);
  useEffect(() => {
    const before = activityBefore.current;
    activityBefore.current = liveActivity;
    if (!sawActivity.current) {
      sawActivity.current = true;
      if (liveActivity !== undefined) openedRunning.current = false;
      return;
    }
    const current = chatRef.current.status;
    const becameRunning = liveActivity === 'running' && before !== 'running';
    if (liveActivity === 'waiting_approval') openedRunning.current = false;
    if (current === 'streaming' || current === 'submitted') {
      if (becameRunning) openedRunning.current = false;
      return;
    }
    if (becameRunning) {
      if (openedRunning.current) {
        openedRunning.current = false;
        return;
      }
      void chatRef.current.resumeStream();
      return;
    }
    if (
      (before === 'running' || before === 'waiting_approval') &&
      liveActivity === undefined
    ) {
      openedRunning.current = false;
      void reload();
    }
  }, [liveActivity, reload]);

  // Opening the session: carry on a run whose decisions are all stored, or
  // send the first message of a new session. Once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial.detail.resumable) {
      const body: ChatRequestBody = { resume: true };
      chatRef.current.sendMessage(undefined, { body });
    } else if (
      options.firstMessage ||
      (options.firstAttachments && options.firstAttachments.length > 0)
    ) {
      const attachments = options.firstAttachments ?? [];
      chatRef.current.sendMessage({
        text: options.firstMessage ?? '',
        ...(attachments.length > 0 ? { metadata: { attachments } } : {}),
      });
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

  /** Starts a run with the message (no run goes on). */
  const sendDirect = useCallback(
    async (draft: OutgoingMessage): Promise<boolean> => {
      carryOnTried.current = false;
      setFailure(undefined);
      setQueueNotice(undefined);
      setInterrupted(false);
      setResendDraft(draft);
      await waitUntilIdle();
      const attachments = draft.attachments ?? [];
      await chatRef.current.sendMessage({
        text: draft.text,
        ...(attachments.length > 0 ? { metadata: { attachments } } : {}),
      });
      return true;
    },
    [waitUntilIdle],
  );

  /** Sends a message that was not read again; not while a run goes on. */
  const sendTextAgain = useCallback(
    async (text: string, attachments?: ChatAttachment[]): Promise<boolean> =>
      activeRunRef.current
        ? false
        : sendDirect({
            text,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          }),
    [sendDirect],
  );

  /** Queues the message. A queue that cannot take it leaves it with the user (`false`). */
  const queueText = useCallback(
    async (draft: OutgoingMessage): Promise<boolean> => {
      setFailure(undefined);
      setQueueNotice(undefined);
      try {
        const item = await api.queueMessage(
          sessionId,
          messageBody(draft, pageRef.current),
        );
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
          return sendDirect(draft);
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
   * Inserts the message into the run. A 409 means that the run is not what the
   * screen thought: read the session, and take the way that fits.
   */
  const insertText = useCallback(
    async (
      runId: string,
      draft: OutgoingMessage,
      retry = true,
    ): Promise<boolean> => {
      setFailure(undefined);
      setQueueNotice(undefined);
      try {
        const item = await api.insertMessage(
          sessionId,
          runId,
          messageBody(draft, pageRef.current),
        );
        // The stream may have said the model read it before this answer came.
        if (!readSeqs.current.has(item.seq)) {
          const stored =
            item.kind === 'user_message' ? item.attachments : undefined;
          let attachments = stored;
          if (!attachments || attachments.length === 0) {
            attachments = draft.attachments;
          }
          if (!attachments || attachments.length === 0) {
            attachments = undefined;
          }
          setPending(current => [
            ...current,
            {
              seq: item.seq,
              text: draft.text,
              ...(attachments ? { attachments } : {}),
            },
          ]);
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
          return queueText(draft);
        }
        if (current?.status === 'running' && current.id !== runId && retry) {
          return insertText(current.id, draft, false);
        }
        if (!current) return sendDirect(draft);
        setFailure(RUN_CANNOT_TAKE_TEXT);
        return false;
      }
    },
    [api, applyQueue, queueText, sendDirect, sessionId],
  );

  /**
   * The message of the box with Enter: a new run when none goes on, an insert
   * into the run, or, while the run waits for a decision, the queue.
   * Resolves with `false` when the message was not taken.
   */
  const send = useCallback(
    async (input: string | OutgoingMessage): Promise<boolean> => {
      const draft = draftOf(input);
      const run = activeRunRef.current;
      if (!run) return sendDirect(draft);
      if (run.status === 'waiting_approval') return queueText(draft);
      return insertText(run.id, draft);
    },
    [insertText, queueText, sendDirect],
  );

  /** The message with Ctrl or Cmd and Enter, or the Queue button. */
  const queueMessage = useCallback(
    async (input: string | OutgoingMessage): Promise<boolean> => {
      const draft = draftOf(input);
      return activeRunRef.current ? queueText(draft) : sendDirect(draft);
    },
    [queueText, sendDirect],
  );

  const sendAgain = useCallback(async () => {
    if (hasContent(resendDraft) && resendDraft) await sendDirect(resendDraft);
  }, [resendDraft, sendDirect]);

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

  /** Moves a queued message by `offset` places (-1 is up one). */
  const moveQueued = useCallback(
    async (id: string, offset: number) => {
      // One move at a time: the next one starts from the order this one made.
      if (movingRef.current) return;
      setQueueNotice(undefined);
      const ids = queueRef.current.items.map(m => m.id);
      const from = ids.indexOf(id);
      const to = from + offset;
      if (from < 0 || offset === 0 || to < 0 || to >= ids.length) return;
      ids.splice(from, 1);
      ids.splice(to, 0, id);
      movingRef.current = true;
      setMoving(true);
      try {
        applyQueue(await api.reorderQueue(sessionId, { ids }), true);
      } catch (error) {
        await queueChangeFailed(error);
      } finally {
        movingRef.current = false;
        if (mounted.current) setMoving(false);
      }
    },
    [api, applyQueue, queueChangeFailed, sessionId],
  );

  /**
   * Moves a queued message into the running run as an inserted message
   * ("send now"). Resolves with `false` when it stayed in the queue.
   */
  const insertQueued = useCallback(
    async (id: string): Promise<boolean> => {
      const run = activeRunRef.current;
      if (run?.status !== 'running' || sendingNowRef.current) return false;
      sendingNowRef.current = true;
      setSendingNow(true);
      setFailure(undefined);
      setQueueNotice(undefined);
      try {
        // Another tab may have changed or sent it: show the stored queue
        // first. The backend inserts what is stored, and the answer says what
        // that was.
        try {
          const stored = await api.getQueue(sessionId);
          if (!mounted.current) return false;
          applyQueue(stored, true);
          if (!stored.items.some(m => m.id === id)) {
            setQueueNotice(QUEUED_GONE_TEXT);
            return false;
          }
        } catch (error) {
          setFailure(describeError(error));
          return false;
        }
        try {
          const item = await api.insertQueuedMessage(sessionId, id, {
            runId: run.id,
          });
          setQueue(current => ({
            ...current,
            items: current.items.filter(m => m.id !== id),
          }));
          if (item.kind === 'user_message' && !readSeqs.current.has(item.seq)) {
            const attachments = item.attachments;
            setPending(current => [
              ...current.filter(m => m.seq !== item.seq),
              {
                seq: item.seq,
                text: item.text,
                ...(attachments && attachments.length > 0
                  ? { attachments }
                  : {}),
              },
            ]);
          }
          return true;
        } catch (error) {
          const name = errorNameOf(error);
          if (name === 'QueuedMessageNotFound') {
            setQueueNotice(QUEUED_GONE_TEXT);
            await refreshQueue();
          } else if (name === 'RunNotRunning') {
            // The run ended or waits for a decision; the queue may have sent
            // this message as the next run.
            setQueueNotice(RUN_NOT_RUNNING_TEXT);
            await reload();
          } else if (name === 'InsertLimitReached') {
            setQueueNotice(INSERT_LIMIT_TEXT);
          } else {
            setFailure(describeError(error));
          }
          return false;
        }
      } finally {
        sendingNowRef.current = false;
        if (mounted.current) setSendingNow(false);
      }
    },
    [api, applyQueue, refreshQueue, reload, sessionId],
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
    canResend: hasContent(resendDraft),
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
    sendTextAgain,
    queueMoving: moving,
    editQueued,
    removeQueued,
    moveQueued,
    insertQueued,
    /** A "send now" is on its way. */
    sendingNow,
    continueQueue,
    decide,
    stop,
  };
}

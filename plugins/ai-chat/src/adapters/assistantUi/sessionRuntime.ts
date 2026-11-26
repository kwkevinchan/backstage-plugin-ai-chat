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

import { useCallback, useMemo, useRef } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
} from '@assistant-ui/react';
import { isToolUIPart } from 'ai';
import type { ChatUiMessage, ToolPart } from '../../domain/types';
import type { SessionQueueAdapter } from './queueAdapter';
import { toThreadMessage } from './toThreadMessage';

export interface SessionRuntimeOptions {
  /** The messages of the session, as `useSessionChat` keeps them. */
  messages: readonly ChatUiMessage[];
  /**
   * A run goes on, also while it waits for a decision, or a response is on
   * its way. The send button of assistant-ui is off then, and Stop is on.
   */
  isRunning: boolean;
  /** Nothing can be sent now; the box can still be typed into. */
  isSendDisabled?: boolean;
  /**
   * Sends the text of the box. Resolves with `false` when the message was not
   * sent: the text goes back into the box, unless the user typed again.
   */
  onSend(text: string): Promise<boolean | void> | void;
  /** Stops the run. Without it there is no Stop. */
  onStop?(): Promise<void> | void;
  /** The decision of the user on a call that waits for approval. */
  onDecide?(callId: string, approved: boolean): Promise<void> | void;
  /**
   * The queue and the inserted messages of the session. With it, the box
   * stays usable while a run goes on, and every send goes through it (also
   * when no run goes on), not through `onSend`.
   */
  queue?: SessionQueueAdapter;
}

function textOf(message: AppendMessage): string {
  return message.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/** The call that an approval id belongs to; the stream uses the call id. */
function callOfApproval(
  messages: readonly ChatUiMessage[],
  approvalId: string,
): string {
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part)) {
        const tool = part as ToolPart;
        if (tool.approval?.id === approvalId) return tool.toolCallId;
      }
    }
  }
  return approvalId;
}

/**
 * The runtime of assistant-ui on the state of `useSessionChat`
 * (`useExternalStoreRuntime`). The state stays in the chat: this only
 * converts the messages and passes the actions on. The queue is the
 * backend's (`queueAdapter`); the queue that assistant-ui keeps in the
 * browser is not used.
 */
export function useSessionRuntime(
  options: SessionRuntimeOptions,
): AssistantRuntime {
  const latest = useRef(options);
  latest.current = options;
  const runtimeRef = useRef<AssistantRuntime>();

  /** A message that was not taken goes back into the box, unless the user typed again. */
  const keepIfNotSent = useCallback((sent: boolean | void, text: string) => {
    if (sent !== false) return;
    const composer = runtimeRef.current?.thread.composer;
    if (composer && !composer.getState().text) composer.setText(text);
  }, []);

  const { onStop, onDecide, queue } = options;
  const queueWithDraft = useMemo<SessionQueueAdapter | undefined>(
    () =>
      queue && {
        ...queue,
        steer: async message => {
          const sent = await queue.steer(message);
          keepIfNotSent(sent, textOf(message));
          return sent;
        },
        enqueue: async message => {
          const sent = await queue.enqueue(message);
          keepIfNotSent(sent, textOf(message));
          return sent;
        },
      },
    [queue, keepIfNotSent],
  );
  const runtime = useExternalStoreRuntime<ChatUiMessage>({
    messages: options.messages,
    convertMessage: toThreadMessage,
    isRunning: options.isRunning,
    isSendDisabled: options.isSendDisabled,
    onNew: async message => {
      const text = textOf(message);
      if (!text) return;
      keepIfNotSent(await latest.current.onSend(text), text);
    },
    queue: queueWithDraft,
    ...(onStop && {
      onCancel: async () => {
        await latest.current.onStop?.();
      },
    }),
    ...(onDecide && {
      onRespondToToolApproval: async ({ approvalId, approved }) => {
        await latest.current.onDecide?.(
          callOfApproval(latest.current.messages, approvalId),
          approved,
        );
      },
    }),
  });
  runtimeRef.current = runtime;
  return runtime;
}

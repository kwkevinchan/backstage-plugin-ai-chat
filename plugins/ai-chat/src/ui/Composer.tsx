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

import type { KeyboardEvent } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import { MAX_MESSAGE_LENGTH } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { useSessionRuntime } from '../adapters/assistantUi/sessionRuntime';
import { cx } from './styles';

type Handler = (text: string) => Promise<boolean | void> | void;

/** What the box does while a run goes on, outside the runtime of assistant-ui. */
export interface ComposerDuringRun {
  /** Enter, and the main button. Resolves with `false` when the message was not sent. */
  onSend: Handler;
  /**
   * Ctrl or Cmd with Enter, and the Queue button, which shows only with this.
   * Without it Ctrl or Cmd with Enter does what Enter does.
   */
  onQueue?: Handler;
  /** Nothing can be sent now. */
  disabled: boolean;
}

export interface ComposerProps {
  /** Shown above the box. */
  hint?: string;
  /** The text of the empty box. */
  placeholder?: string;
  /** The name of the main button while a run goes on; default Send. */
  sendLabel?: string;
  /**
   * Set while a run goes on. The send of assistant-ui is off then, so the
   * box takes messages through these handlers (the run adds or queues them).
   */
  duringRun?: ComposerDuringRun;
  /** Shows Stop, which stops the run through the runtime. */
  canStop?: boolean;
}

const DEFAULT_PLACEHOLDER =
  'Write a message (Enter sends, Shift+Enter starts a new line)';

/**
 * The input box of the runtime around it: Send when no run goes on, Send and
 * Queue for a run that goes on, and Stop.
 */
export function Composer(props: ComposerProps) {
  const aui = useAui();
  const empty = useAuiState(s => !s.composer.text.trim());
  // The primitive buttons pass `disabled` to their child, which the Button of
  // @backstage/ui (React Aria) does not read: it takes `isDisabled`.
  const canSend = useAuiState(s => s.composer.canSend);
  const canCancel = useAuiState(s => s.composer.canCancel);
  const { duringRun } = props;

  const submitDuringRun = async (run: ComposerDuringRun, queue: boolean) => {
    const text = aui.composer.getState().text.trim();
    if (!text || run.disabled) return;
    aui.composer.setText('');
    const handler = queue && run.onQueue ? run.onQueue : run.onSend;
    const sent = await handler(text);
    // A message that was not sent goes back into the box, unless the user typed again.
    if (sent === false && !aui.composer.getState().text) {
      aui.composer.setText(text);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!duringRun || event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing) return;
    const modified = event.ctrlKey || event.metaKey;
    if (event.shiftKey && !modified) return;
    event.preventDefault();
    submitDuringRun(duringRun, modified);
  };

  return (
    <>
      {props.hint && (
        <div className={cx('chat-composer-hint')}>{props.hint}</div>
      )}
      <ComposerPrimitive.Root className={cx('chat-composer')}>
        <ComposerPrimitive.Input
          className={cx('chat-composer-input')}
          aria-label="Message"
          placeholder={props.placeholder ?? DEFAULT_PLACEHOLDER}
          minRows={2}
          maxRows={6}
          maxLength={MAX_MESSAGE_LENGTH}
          onKeyDown={onKeyDown}
        />
        {props.canStop && (
          <ComposerPrimitive.Cancel asChild>
            <Button variant="secondary" isDisabled={!canCancel}>
              Stop
            </Button>
          </ComposerPrimitive.Cancel>
        )}
        {duringRun?.onQueue && (
          <Button
            variant="secondary"
            isDisabled={duringRun.disabled || empty}
            onPress={() => submitDuringRun(duringRun, true)}
          >
            Queue
          </Button>
        )}
        {duringRun ? (
          <Button
            variant="primary"
            isDisabled={duringRun.disabled || empty}
            onPress={() => submitDuringRun(duringRun, false)}
          >
            {props.sendLabel ?? 'Send'}
          </Button>
        ) : (
          <ComposerPrimitive.Send asChild>
            <Button variant="primary" isDisabled={!canSend}>
              Send
            </Button>
          </ComposerPrimitive.Send>
        )}
      </ComposerPrimitive.Root>
    </>
  );
}

export interface DraftComposerProps {
  /** Resolves with `false` when the message was not sent: the text stays in the box. */
  onSend: Handler;
  disabled: boolean;
}

const NO_MESSAGES: never[] = [];

/** The input box of a session that does not exist yet: the first message creates it. */
export function DraftComposer(props: DraftComposerProps) {
  const runtime = useSessionRuntime({
    messages: NO_MESSAGES,
    isRunning: false,
    isSendDisabled: props.disabled,
    onSend: props.onSend,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer />
    </AssistantRuntimeProvider>
  );
}

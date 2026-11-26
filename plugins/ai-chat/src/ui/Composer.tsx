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

export interface ComposerProps {
  /** Shown above the box. */
  hint?: string;
  /** The text of the empty box. */
  placeholder?: string;
  /** The name of the main button; default Send. */
  sendLabel?: string;
  /** Shows the Queue button (a run is `running`). */
  canQueue?: boolean;
  /** Shows Stop, which stops the run through the runtime. */
  canStop?: boolean;
}

const DEFAULT_PLACEHOLDER =
  'Write a message (Enter sends, Shift+Enter starts a new line)';

/**
 * The input box, on the composer of assistant-ui. With the queue of the
 * session in the runtime, Enter steers (inserts into a running run) and
 * Ctrl or Cmd with Enter, or the Queue button, enqueues; the queue adapter
 * decides what that means for the state of the run.
 */
export function Composer(props: ComposerProps) {
  const aui = useAui();
  // The primitive buttons pass `disabled` to their child, which the Button of
  // @backstage/ui (React Aria) does not read: it takes `isDisabled`.
  const canSend = useAuiState(s => s.composer.canSend);
  const canCancel = useAuiState(s => s.composer.canCancel);

  const enqueue = () => {
    if (aui.composer.getState().canSend) aui.composer.send({ steer: false });
  };
  // The default of assistant-ui steers on Ctrl or Cmd with Enter as well.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    // keyCode 229: some browsers end a composition with this Enter.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (!aui.thread.getState().capabilities.queue) return;
    event.preventDefault();
    enqueue();
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
          // Escape does not stop a run; only the Stop button does.
          cancelOnEscape={false}
          onKeyDown={onKeyDown}
        />
        {props.canStop && (
          <ComposerPrimitive.Cancel asChild>
            <Button variant="secondary" isDisabled={!canCancel}>
              Stop
            </Button>
          </ComposerPrimitive.Cancel>
        )}
        {props.canQueue && (
          <Button variant="secondary" isDisabled={!canSend} onPress={enqueue}>
            Queue
          </Button>
        )}
        <ComposerPrimitive.Send asChild>
          <Button variant="primary" isDisabled={!canSend}>
            {props.sendLabel ?? 'Send'}
          </Button>
        </ComposerPrimitive.Send>
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

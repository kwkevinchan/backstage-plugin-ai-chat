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

import { useEffect, useMemo, type KeyboardEvent } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import { MAX_MESSAGE_LENGTH } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AttachmentSource } from '../adapters/assistantUi/attachmentAdapter';
import { useSessionRuntime } from '../adapters/assistantUi/sessionRuntime';
import type { SendContents } from '../application/sendContents';
import type { OutgoingMessage } from '../domain/types';
import {
  AttachButton,
  AttachmentRejections,
  DraftImages,
  RejectionNotes,
} from './Attachments';
import { SendContentsBar } from './SendContents';
import { cx } from './styles';

type Handler = (message: OutgoingMessage) => Promise<boolean | void> | void;

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
  /** Why images were not taken; give the same notes to the attachments of the runtime. */
  rejections?: RejectionNotes;
  /** Called when a completed draft image is removed from the composer. */
  onRemoveAttachment?: (attachmentId: string) => Promise<void> | void;
  /** The page and the references of the next message; without it, no tags. */
  contents?: SendContents;
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
  // A message waits for its images: assistant-ui would send it as a
  // submission, which an inserted or queued message leaves in the thread.
  const uploading = useAuiState(s =>
    s.composer.attachments.some(a => a.status.type === 'running'),
  );
  const canSend = useAuiState(s => s.composer.canSend) && !uploading;
  const canCancel = useAuiState(s => s.composer.canCancel);

  const enqueue = () => {
    if (canSend) aui.composer.send({ steer: false });
  };
  // The default of assistant-ui steers on Ctrl or Cmd with Enter as well.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    // keyCode 229: some browsers end a composition with this Enter.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (uploading && !event.shiftKey) {
      event.preventDefault();
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
      <ComposerPrimitive.AttachmentDropzone className={cx('chat-composer-box')}>
        {props.contents && <SendContentsBar contents={props.contents} />}
        {props.rejections && <AttachmentRejections notes={props.rejections} />}
        <DraftImages onRemove={props.onRemoveAttachment} />
        <ComposerPrimitive.Root className={cx('chat-composer')}>
          <AttachButton />
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
      </ComposerPrimitive.AttachmentDropzone>
    </>
  );
}

export interface DraftComposerProps {
  /** Resolves with `false` when the message was not sent: it stays in the box. */
  onSend: Handler;
  disabled: boolean;
  /** The uploads; without it there is no attach button. */
  attachments?: AttachmentSource;
  /** The page and the references of the first message. */
  contents?: SendContents;
  /**
   * Text to put in the box, not sent. It is put in again when `textKey`
   * changes, replacing what the box holds.
   */
  text?: string;
  textKey?: number;
}

const NO_MESSAGES: never[] = [];

/** The input box of a session that does not exist yet: the first message creates it. */
export function DraftComposer(props: DraftComposerProps) {
  const rejections = useMemo(() => new RejectionNotes(), []);
  const { attachments } = props;
  const withNotes = useMemo(
    () => attachments && { ...attachments, onAdd: rejections.begin },
    [attachments, rejections],
  );
  const runtime = useSessionRuntime({
    messages: NO_MESSAGES,
    isRunning: false,
    isSendDisabled: props.disabled,
    onSend: props.onSend,
    attachments: withNotes,
  });
  const { text, textKey } = props;
  useEffect(() => {
    if (text) runtime.thread.composer.setText(text);
    // Only a new key puts the text in again: the user may have edited it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, textKey]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer
        rejections={rejections}
        onRemoveAttachment={attachments?.remove}
        contents={props.contents}
      />
    </AssistantRuntimeProvider>
  );
}

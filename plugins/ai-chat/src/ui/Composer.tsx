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

import { KeyboardEvent, useState } from 'react';
import { Button } from '@backstage/ui';
import { MAX_MESSAGE_LENGTH } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { cx } from './styles';

export interface ComposerProps {
  /**
   * Enter, and the Send button. Resolves with `false` when the message was not
   * sent at all.
   */
  onSend(text: string): Promise<boolean | void> | void;
  /**
   * Ctrl or Cmd with Enter, and the Queue button, which shows only with this.
   * Without it Ctrl or Cmd with Enter does what Enter does.
   */
  onQueue?(text: string): Promise<boolean | void> | void;
  /** A response is on its way that the new message cannot join. */
  disabled: boolean;
  /** Shown above the box. */
  hint?: string;
  /** The text of the empty box. */
  placeholder?: string;
  /** The name of the main button; default Send. */
  sendLabel?: string;
  /** Set while a run is active: shows Stop. */
  onStop?(): void;
}

const DEFAULT_PLACEHOLDER =
  'Write a message (Enter sends, Shift+Enter starts a new line)';

/** The input box with Send, Queue while a run is active, and Stop. */
export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState('');

  const submit = async (queue: boolean) => {
    const text = draft.trim();
    if (!text || props.disabled) return;
    setDraft('');
    const handler = queue && props.onQueue ? props.onQueue : props.onSend;
    const sent = await handler(text);
    // A message that was not sent goes back into the box, unless the user typed again.
    if (sent === false) setDraft(current => current || text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    const modified = event.ctrlKey || event.metaKey;
    if (event.shiftKey && !modified) return;
    event.preventDefault();
    submit(modified);
  };
  const empty = !draft.trim();

  return (
    <>
      {props.hint && (
        <div className={cx('chat-composer-hint')}>{props.hint}</div>
      )}
      <div className={cx('chat-composer')}>
        <textarea
          className={cx('chat-composer-input')}
          aria-label="Message"
          placeholder={props.placeholder ?? DEFAULT_PLACEHOLDER}
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {props.onStop && (
          <Button variant="secondary" onPress={props.onStop}>
            Stop
          </Button>
        )}
        {props.onQueue && (
          <Button
            variant="secondary"
            isDisabled={props.disabled || empty}
            onPress={() => submit(true)}
          >
            Queue
          </Button>
        )}
        <Button
          variant="primary"
          isDisabled={props.disabled || empty}
          onPress={() => submit(false)}
        >
          {props.sendLabel ?? 'Send'}
        </Button>
      </div>
    </>
  );
}

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
  /** Sends the text. Resolves with `false` when the message was not sent at all. */
  onSend(text: string): Promise<boolean | void> | void;
  /** A response is on its way, or a run waits: a new message cannot start now. */
  disabled: boolean;
  /** Shown above the box. */
  hint?: string;
  /** Set while a run is active: shows Stop. */
  onStop?(): void;
}

/** The input box with Send, and Stop while a run is active. */
export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState('');

  const submit = async () => {
    const text = draft.trim();
    if (!text || props.disabled) return;
    setDraft('');
    const sent = await props.onSend(text);
    // A message that was not sent goes back into the box, unless the user typed again.
    if (sent === false) setDraft(current => current || text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <>
      {props.hint && (
        <div className={cx('chat-composer-hint')}>{props.hint}</div>
      )}
      <div className={cx('chat-composer')}>
        <textarea
          className={cx('chat-composer-input')}
          aria-label="Message"
          placeholder="Write a message (Enter sends, Shift+Enter starts a new line)"
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
        <Button
          variant="primary"
          isDisabled={props.disabled || !draft.trim()}
          onPress={submit}
        >
          Send
        </Button>
      </div>
    </>
  );
}

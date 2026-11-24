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

import { useState } from 'react';
import { Button } from '@backstage/ui';
import {
  MAX_MESSAGE_LENGTH,
  type ChatQueuedMessage,
  type ChatQueuePausedReason,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { cx } from './styles';

/** Why the queue is paused, for the screen. The reason is not known after a reload. */
export const PAUSED_TEXT: Record<ChatQueuePausedReason | 'unknown', string> = {
  run_not_completed: 'Queue paused. The last run did not end normally.',
  credentials:
    'Queue paused. Your sign-in is about to expire; Continue uses your new sign-in.',
  shutting_down: 'Queue paused. The server was shutting down.',
  unknown: 'Queue paused. Nothing is sent until you continue.',
};

export const QUEUE_FIRST_NOTE = 'New messages go first, the queue follows';

export interface QueuePanelProps {
  items: ChatQueuedMessage[];
  paused: boolean;
  pausedReason?: ChatQueuePausedReason;
  /** One line about what the last action found (a message that was sent already, say). */
  notice?: string;
  onContinue(): void;
  /** Resolves with `false` when the change was not stored. */
  onEdit(id: string, text: string): Promise<boolean>;
  onRemove(id: string): void;
  /** A move is on its way: the arrows wait for it. */
  moving?: boolean;
  onMove(id: string, direction: -1 | 1): void;
}

function QueueRow(props: {
  item: ChatQueuedMessage;
  first: boolean;
  last: boolean;
  moving?: boolean;
  onEdit(id: string, text: string): Promise<boolean>;
  onRemove(id: string): void;
  onMove(id: string, direction: -1 | 1): void;
}) {
  const { item } = props;
  const [draft, setDraft] = useState<string>();

  if (draft !== undefined) {
    const save = async () => {
      const text = draft.trim();
      if (!text) return;
      if (text === item.text || (await props.onEdit(item.id, text))) {
        setDraft(undefined);
      }
    };
    return (
      <li className={cx('chat-queue-item')}>
        <textarea
          className={cx('chat-composer-input')}
          aria-label="Queued message"
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <span className={cx('chat-queue-actions')}>
          <button type="button" onClick={save} disabled={!draft.trim()}>
            Save
          </button>
          <button type="button" onClick={() => setDraft(undefined)}>
            Cancel
          </button>
        </span>
      </li>
    );
  }
  return (
    <li className={cx('chat-queue-item')}>
      <span className={cx('chat-queue-text')} title={item.text}>
        {item.text}
      </span>
      {item.attachments && item.attachments.length > 0 && (
        <span className={cx('chat-queue-images')}>
          {item.attachments.length === 1
            ? '1 image'
            : `${item.attachments.length} images`}
        </span>
      )}
      <span className={cx('chat-queue-actions')}>
        <button
          type="button"
          aria-label="Move up"
          disabled={props.first || props.moving}
          onClick={() => props.onMove(item.id, -1)}
        >
          Up
        </button>
        <button
          type="button"
          aria-label="Move down"
          disabled={props.last || props.moving}
          onClick={() => props.onMove(item.id, 1)}
        >
          Down
        </button>
        <button
          type="button"
          aria-label="Edit"
          onClick={() => setDraft(item.text)}
        >
          Edit
        </button>
        <button
          type="button"
          aria-label="Delete"
          onClick={() => props.onRemove(item.id)}
        >
          Delete
        </button>
      </span>
    </li>
  );
}

/**
 * The messages that wait for the run to end, above the input box: one row for
 * each, to change, delete and move. A paused queue says why, and has Continue.
 */
export function QueuePanel(props: QueuePanelProps) {
  const { items, paused } = props;
  if (items.length === 0 && !props.notice) return null;
  return (
    <section className={cx('chat-queue')} aria-label="Queue">
      {items.length > 0 && (
        <div className={cx('chat-queue-title')}>
          <strong>Queued ({items.length})</strong>
          {paused && <span>{QUEUE_FIRST_NOTE}</span>}
        </div>
      )}
      {paused && items.length > 0 && (
        <div className={cx('chat-queue-paused')} role="status">
          {PAUSED_TEXT[props.pausedReason ?? 'unknown']}{' '}
          <Button variant="primary" size="small" onPress={props.onContinue}>
            Continue
          </Button>
        </div>
      )}
      {props.notice && (
        <div className={cx('chat-queue-notice')} role="status">
          {props.notice}
        </div>
      )}
      <ul className={cx('chat-queue-list')}>
        {items.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            first={index === 0}
            last={index === items.length - 1}
            moving={props.moving}
            onEdit={props.onEdit}
            onRemove={props.onRemove}
            onMove={props.onMove}
          />
        ))}
      </ul>
    </section>
  );
}

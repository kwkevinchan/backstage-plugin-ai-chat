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
import {
  ComposerPrimitive,
  QueueItemPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import {
  MAX_MESSAGE_LENGTH,
  type ChatQueuePausedReason,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { SessionQueueAdapter } from '../adapters/assistantUi/queueAdapter';
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
export const WAITING_TEXT =
  'The agent has not read this yet. It will at the next step.';
export const queueFullText = (max: number) =>
  `The queue is full: it holds at most ${max} messages.`;

export interface ComposerQueueProps {
  /** The two lanes and their actions; both come from the backend. */
  queue: SessionQueueAdapter;
  paused: boolean;
  pausedReason?: ChatQueuePausedReason;
  /** One line about what the last action found (a message that was sent already, say). */
  notice?: string;
  onContinue(): void;
  /** A move is on its way: the arrows wait for it. */
  moving?: boolean;
  /** "Send now" can move a queued message into the run: it is `running`, and no send now is on its way. */
  canSendNow: boolean;
  /** Most messages in the queue. */
  maxMessages: number;
}

function ImageCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className={cx('chat-queue-images')}>
      {count === 1 ? '1 image' : `${count} images`}
    </span>
  );
}

/** A message inserted into the run: no Delete and no Send now, it is in the run already. */
function InsertedRow({ queue }: { queue: SessionQueueAdapter }) {
  const id = useAuiState(s => s.queueItem.id);
  return (
    <li className={cx('chat-pending-item')}>
      <QueueItemPrimitive.Text className={cx('chat-pending-text')} />
      <ImageCount count={queue.imageCountOf(id)} />
      <span className={cx('chat-pending-label')}>{WAITING_TEXT}</span>
    </li>
  );
}

function QueuedRow(props: {
  queue: SessionQueueAdapter;
  moving?: boolean;
  canSendNow: boolean;
}) {
  const { queue } = props;
  const aui = useAui();
  const id = useAuiState(s => s.queueItem.id);
  const text = useAuiState(s =>
    s.queueItem.parts
      .map(part => (part.type === 'text' ? part.text : ''))
      .join(''),
  );
  const [draft, setDraft] = useState<string>();
  const ids = queue.items.map(item => item.id);
  const index = ids.indexOf(id);

  if (draft !== undefined) {
    const save = async () => {
      if (!draft.trim()) return;
      if (draft.trim() === text || (await queue.editText(id, draft))) {
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
      <QueueItemPrimitive.Text className={cx('chat-queue-text')} title={text} />
      <ImageCount count={queue.imageCountOf(id)} />
      <span className={cx('chat-queue-actions')}>
        <button
          type="button"
          aria-label="Move up"
          disabled={index <= 0 || props.moving}
          onClick={() =>
            aui.queueItem.move({ lane: 'queue', insertBefore: ids[index - 1] })
          }
        >
          Up
        </button>
        <button
          type="button"
          aria-label="Move down"
          disabled={index < 0 || index >= ids.length - 1 || props.moving}
          onClick={() =>
            aui.queueItem.move({ lane: 'queue', insertAfter: ids[index + 1] })
          }
        >
          Down
        </button>
        <button type="button" aria-label="Edit" onClick={() => setDraft(text)}>
          Edit
        </button>
        <QueueItemPrimitive.Remove aria-label="Delete">
          Delete
        </QueueItemPrimitive.Remove>
        <QueueItemPrimitive.Steer
          aria-label="Send now"
          title="Add this message to the run that goes on"
          disabled={!props.canSendNow}
        >
          Send now
        </QueueItemPrimitive.Steer>
      </span>
    </li>
  );
}

/**
 * The queue of assistant-ui (`ComposerPrimitive.Queue`), above the box. Its
 * list has both lanes, the inserted messages first; the id tells the lane.
 * The pause, the limit and the notices are not in its model: drawn here.
 */
export function ComposerQueue(props: ComposerQueueProps) {
  const { queue, paused } = props;
  const queued = queue.items.length;
  const inserted = queue.steerItems.length;
  return (
    <>
      {(queued > 0 || props.notice) && (
        <section className={cx('chat-queue')} aria-label="Queue">
          {queued > 0 && (
            <div className={cx('chat-queue-title')}>
              <strong>Queued ({queued})</strong>
              {paused && <span>{QUEUE_FIRST_NOTE}</span>}
            </div>
          )}
          {paused && queued > 0 && (
            <div className={cx('chat-queue-paused')} role="status">
              {PAUSED_TEXT[props.pausedReason ?? 'unknown']}{' '}
              <Button variant="primary" size="small" onPress={props.onContinue}>
                Continue
              </Button>
            </div>
          )}
          {queued >= props.maxMessages && (
            <div className={cx('chat-queue-notice')}>
              {queueFullText(props.maxMessages)}
            </div>
          )}
          {props.notice && (
            <div className={cx('chat-queue-notice')} role="status">
              {props.notice}
            </div>
          )}
          {queued > 0 && (
            <ul className={cx('chat-queue-list')}>
              <ComposerPrimitive.Queue>
                {({ queueItem }) =>
                  queue.laneOf(queueItem.id) === 'queue' ? (
                    <QueuedRow
                      queue={queue}
                      moving={props.moving}
                      canSendNow={props.canSendNow}
                    />
                  ) : null
                }
              </ComposerPrimitive.Queue>
            </ul>
          )}
        </section>
      )}
      {inserted > 0 && (
        <ul className={cx('chat-pending')} aria-label="Waiting to be read">
          <ComposerPrimitive.Queue>
            {({ queueItem }) =>
              queue.laneOf(queueItem.id) === 'steer' ? (
                <InsertedRow queue={queue} />
              ) : null
            }
          </ComposerPrimitive.Queue>
        </ul>
      )}
    </>
  );
}

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

import { useMemo } from 'react';
import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  QueueItemState,
} from '@assistant-ui/react';
import type {
  ChatAttachment,
  ChatQueuedMessage,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';

/** Where `move` puts an item (not exported by name from `@assistant-ui/react`). */
type QueuePlacement = Parameters<ExternalThreadQueueAdapter['move']>[1];

/** A message that was inserted into the run and not read yet. */
export interface InsertedMessage {
  seq: number;
  text: string;
  attachments?: ChatAttachment[];
}

/** What the queue of assistant-ui is made of: the state and the actions of `useSessionChat`. */
export interface SessionQueueSource {
  /** The queue that the backend stores. */
  queued: readonly ChatQueuedMessage[];
  /** The messages inserted into the run that the model has not read. */
  inserted: readonly InsertedMessage[];
  /** Inserts into a running run, queues while it waits for a decision, or sends with no run. */
  send(text: string): Promise<boolean>;
  /** Queues while a run goes on, or sends with no run. */
  queueMessage(text: string): Promise<boolean>;
  editQueued(id: string, text: string): Promise<boolean>;
  removeQueued(id: string): Promise<void>;
  /** Moves a queued message by `offset` places. */
  moveQueued(id: string, offset: number): Promise<void>;
  /** Moves a queued message into the running run. */
  insertQueued(id: string): Promise<boolean>;
}

/**
 * The queue of assistant-ui on the queue of the backend. It keeps no state:
 * both lanes come from the backend, and each action calls the backend.
 * The actions resolve with what happened (`false`: nothing changed), which
 * the screen uses beyond the `void` of the interface.
 */
export interface SessionQueueAdapter extends ExternalThreadQueueAdapter {
  steer(message: AppendMessage): Promise<boolean>;
  enqueue(message: AppendMessage): Promise<boolean>;
  edit(queueItemId: string, message: AppendMessage): Promise<boolean>;
  remove(queueItemId: string): Promise<void>;
  move(queueItemId: string, placement: QueuePlacement): Promise<void>;
  /** Changes the text of a queued message. */
  editText(queueItemId: string, text: string): Promise<boolean>;
  /** The lane of an item; inserted messages are in `steer`. */
  laneOf(queueItemId: string): 'queue' | 'steer' | undefined;
  /** The number of images of an item. */
  imageCountOf(queueItemId: string): number;
}

/** The id of an inserted message in the steer lane; queued messages keep the id of the backend. */
export const insertedItemId = (seq: number) => `inserted-${seq}`;

function textOf(message: AppendMessage): string {
  return message.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function itemOf(id: string, text: string): QueueItemState {
  return { id, prompt: text, parts: [{ type: 'text', text }] };
}

/** The place in the queue lane that a placement asks for, without the item itself. */
function targetIndex(
  rest: readonly string[],
  placement: QueuePlacement,
): number | undefined {
  if (placement.insertBefore) {
    const at = rest.indexOf(placement.insertBefore);
    return at < 0 ? undefined : at;
  }
  if (placement.insertAfter) {
    const at = rest.indexOf(placement.insertAfter);
    return at < 0 ? undefined : at + 1;
  }
  if (placement.insertAfter === null) return 0;
  return rest.length;
}

export function createQueueAdapter(
  source: SessionQueueSource,
): SessionQueueAdapter {
  const steerItems = source.inserted.map(m =>
    itemOf(insertedItemId(m.seq), m.text),
  );
  const items = source.queued.map(m => itemOf(m.id, m.text));
  const images = new Map<string, number>([
    ...source.inserted.map(
      m => [insertedItemId(m.seq), m.attachments?.length ?? 0] as const,
    ),
    ...source.queued.map(m => [m.id, m.attachments?.length ?? 0] as const),
  ]);
  const laneOf = (id: string) => {
    if (steerItems.some(item => item.id === id)) return 'steer' as const;
    if (items.some(item => item.id === id)) return 'queue' as const;
    return undefined;
  };
  const editText = async (id: string, text: string) => {
    const trimmed = text.trim();
    if (laneOf(id) !== 'queue' || !trimmed) return false;
    return source.editQueued(id, trimmed);
  };
  return {
    items,
    steerItems,
    laneOf,
    imageCountOf: id => images.get(id) ?? 0,
    // Enter while a run goes on.
    steer: async message => {
      const text = textOf(message);
      return text ? source.send(text) : false;
    },
    // Ctrl or Cmd with Enter, and the Queue button. With no run,
    // assistant-ui sends through `enqueue`; `queueMessage` starts the run then.
    enqueue: async message => {
      const text = textOf(message);
      return text ? source.queueMessage(text) : false;
    },
    edit: (id, message) => editText(id, textOf(message)),
    editText,
    // An inserted message is in the run already: it cannot be removed or moved.
    remove: async id => {
      if (laneOf(id) === 'queue') await source.removeQueued(id);
    },
    move: async (id, placement) => {
      if (laneOf(id) !== 'queue') return;
      if (placement.lane === 'steer') {
        await source.insertQueued(id);
        return;
      }
      const ids = items.map(item => item.id);
      const from = ids.indexOf(id);
      const to = targetIndex(
        ids.filter(other => other !== id),
        placement,
      );
      if (to === undefined || to === from) return;
      await source.moveQueued(id, to - from);
    },
  };
}

/** The queue adapter of a session, made again when the queue or the inserted messages change. */
export function useQueueAdapter(
  source: SessionQueueSource,
): SessionQueueAdapter {
  const {
    queued,
    inserted,
    send,
    queueMessage,
    editQueued,
    removeQueued,
    moveQueued,
    insertQueued,
  } = source;
  return useMemo(
    () =>
      createQueueAdapter({
        queued,
        inserted,
        send,
        queueMessage,
        editQueued,
        removeQueued,
        moveQueued,
        insertQueued,
      }),
    [
      queued,
      inserted,
      send,
      queueMessage,
      editQueued,
      removeQueued,
      moveQueued,
      insertQueued,
    ],
  );
}

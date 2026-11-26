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

import type {
  ChatAttachment,
  ChatItem,
  ChatQueue,
  ChatQueuedMessage,
  ChatRun,
  ChatSession,
  ChatSessionDetail,
  ChatShare,
  ChatToolset,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { SessionView, ShareView } from '../../../application';
import {
  shareModeOf,
  type QueuedMessage,
  type Run,
  type Session,
  type Toolset,
} from '../../../domain';

/** The fields of a session that the owner gets, and no others. */
export function toChatSession(
  session: Session,
  activity?: ChatSession['activity'],
): ChatSession {
  return {
    id: session.id,
    ownerRef: session.ownerRef,
    agentId: session.agentId,
    ...(session.title !== undefined && { title: session.title }),
    ...(session.entityRef !== undefined && { entityRef: session.entityRef }),
    enabledToolsets: session.enabledToolsets,
    pinned: session.pinned,
    ...(session.archivedAt !== undefined && { archivedAt: session.archivedAt }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(activity && { activity }),
  };
}

/** A run without the lease, which only the backends use. */
export function toChatRun(run: Run): ChatRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    cancelRequested: run.cancelRequested,
    ...(run.endReason !== undefined && { endReason: run.endReason }),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
  };
}

/** The fields of an image that the owner gets: no hash, no session. */
export function toChatAttachment(meta: {
  id: string;
  mediaType: string;
  name: string;
  size: number;
}): ChatAttachment {
  return {
    id: meta.id,
    mediaType: meta.mediaType,
    name: meta.name,
    size: meta.size,
  };
}

export function toChatQueuedMessage(message: QueuedMessage): ChatQueuedMessage {
  return {
    id: message.id,
    position: message.position,
    text: message.text,
    attachments: message.attachments.map(toChatAttachment),
    ...(message.page && { page: message.page }),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

export function toChatQueue(queue: {
  items: QueuedMessage[];
  paused: boolean;
}): ChatQueue {
  return {
    items: queue.items.map(toChatQueuedMessage),
    paused: queue.paused,
  };
}

export function toChatSessionDetail(view: SessionView): ChatSessionDetail {
  // The items are the log as it is stored; the type of the API is checked
  // against the type of the core here. An inserted message also says whether
  // the model read it.
  const items: ChatItem[] = view.items.map(item => {
    const insertState = view.insertStates.get(item.seq);
    return insertState === undefined ? item : { ...item, insertState };
  });
  return {
    session: toChatSession(view.session),
    ...(view.run && { run: toChatRun(view.run) }),
    items,
    awaitingDecision: view.awaitingDecision,
    resumable: view.resumable,
    queue: toChatQueue(view.queue),
    ...(view.shared && { shared: view.shared }),
  };
}

export function toChatToolset(toolset: Toolset): ChatToolset {
  return {
    id: toolset.id,
    ...(toolset.title !== undefined && { title: toolset.title }),
    default: toolset.default,
    egress: toolset.egress,
  };
}

export function toChatShare({ share, expired }: ShareView): ChatShare {
  return {
    id: share.id,
    subjectRef: share.subjectRef,
    mode: shareModeOf(share),
    ...(share.upToSeq !== undefined && { upToSeq: share.upToSeq }),
    ...(share.outputsUpToSeq !== undefined && {
      outputsUpToSeq: share.outputsUpToSeq,
    }),
    ...(share.expiresAt !== undefined && { expiresAt: share.expiresAt }),
    expired,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
  };
}

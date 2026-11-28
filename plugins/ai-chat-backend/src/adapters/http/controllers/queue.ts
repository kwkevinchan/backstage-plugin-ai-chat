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
  ChatItem,
  ChatQueue,
  ChatQueuedMessage,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  DeleteQueuedMessage,
  InsertQueuedMessage,
  ListQueue,
  QueueMessage,
  ReorderQueue,
  UpdateQueuedMessage,
} from '../../../application';
import type { Principal } from '../../../domain';
import { toChatQueue, toChatQueuedMessage } from '../presenters/session';
import {
  insertQueuedMessageBody,
  parse,
  queueMessageBody,
  reorderQueueBody,
  updateQueuedMessageBody,
} from '../requestSchemas';

export type QueueUseCases = {
  listQueue: Pick<ListQueue, 'execute'>;
  queueMessage: Pick<QueueMessage, 'execute'>;
  updateQueuedMessage: Pick<UpdateQueuedMessage, 'execute'>;
  deleteQueuedMessage: Pick<DeleteQueuedMessage, 'execute'>;
  reorderQueue: Pick<ReorderQueue, 'execute'>;
  insertQueuedMessage: Pick<InsertQueuedMessage, 'execute'>;
};

/** The JSON routes of the queue of a session. */
export class QueueController {
  constructor(private readonly useCases: QueueUseCases) {}

  /** `GET /sessions/:id/queue` */
  async list(principal: Principal, sessionId: string): Promise<ChatQueue> {
    return toChatQueue(
      await this.useCases.listQueue.execute({ principal, sessionId }),
    );
  }

  /** `POST /sessions/:id/queue` */
  async add(
    principal: Principal,
    sessionId: string,
    body: unknown,
  ): Promise<ChatQueuedMessage> {
    const { text, attachmentIds, page, references } = parse(
      queueMessageBody,
      body,
    );
    return toChatQueuedMessage(
      await this.useCases.queueMessage.execute({
        principal,
        sessionId,
        text,
        ...(attachmentIds && { attachmentIds }),
        ...(page && { page }),
        ...(references && { references }),
      }),
    );
  }

  /** `PATCH /sessions/:id/queue/:queuedId` */
  async update(
    principal: Principal,
    sessionId: string,
    queuedId: string,
    body: unknown,
  ): Promise<ChatQueuedMessage> {
    const patch = parse(updateQueuedMessageBody, body);
    return toChatQueuedMessage(
      await this.useCases.updateQueuedMessage.execute({
        principal,
        sessionId,
        queuedId,
        patch,
      }),
    );
  }

  /** `DELETE /sessions/:id/queue/:queuedId` */
  async remove(
    principal: Principal,
    sessionId: string,
    queuedId: string,
  ): Promise<void> {
    await this.useCases.deleteQueuedMessage.execute({
      principal,
      sessionId,
      queuedId,
    });
  }

  /** `POST /sessions/:id/queue/:queuedId/insert` */
  async insert(
    principal: Principal,
    sessionId: string,
    queuedId: string,
    body: unknown,
  ): Promise<ChatItem> {
    const { runId } = parse(insertQueuedMessageBody, body);
    return this.useCases.insertQueuedMessage.execute({
      principal,
      sessionId,
      queuedId,
      runId,
    });
  }

  /** `PUT /sessions/:id/queue/order` */
  async reorder(
    principal: Principal,
    sessionId: string,
    body: unknown,
  ): Promise<ChatQueue> {
    const { ids } = parse(reorderQueueBody, body);
    return toChatQueue(
      await this.useCases.reorderQueue.execute({ principal, sessionId, ids }),
    );
  }
}

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

import type { PageContext } from '@kwkevinchan/ai-chat-harness';
import { assertOwner, type Principal, type QueuedMessage } from '../../domain';
import { bindAttachments, type ImageSettings } from '../attachments';
import {
  resolveReferences,
  type ReferenceInput,
  type ReferenceSettings,
} from '../references';
import type {
  AttachmentStore,
  EntityReader,
  Logger,
  QueuedMessageRepository,
  SessionRepository,
} from '../ports';

/** The user queues a message for when the run ends (IN-13). */
export class QueueMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      /** `aiChat.input.queue.maxMessages`. */
      maxMessages: number;
      attachments: AttachmentStore;
      images: ImageSettings;
      entities: EntityReader;
      references: ReferenceSettings;
      logger?: Logger;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `NoActiveRun`, `QueueFull`, or, for the images,
   * `ImagesNotSupported`, `TooManyAttachments` or `UnknownAttachment`, or
   * `TooManyReferences`. The entities of the references are read now, with
   * the credentials of this request, and the queue keeps what was read: the
   * user may not be there, with credentials, when the message is sent.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    text: string;
    attachmentIds?: string[];
    page?: PageContext;
    references?: ReferenceInput[];
  }): Promise<QueuedMessage> {
    const { sessions, queue, maxMessages } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    await bindAttachments(this.deps, session.id, input.attachmentIds);
    const references = await resolveReferences(
      this.deps,
      input.principal,
      input.references,
    );
    return queue.add(
      session.id,
      {
        text: input.text,
        attachmentIds: input.attachmentIds ?? [],
        ...(input.page && { page: input.page }),
        ...(references.length > 0 && { references }),
      },
      { max: maxMessages },
    );
  }
}

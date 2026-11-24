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
import type {
  AttachmentStore,
  QueuedMessageRepository,
  SessionRepository,
} from '../ports';

/** The user changes a queued message that was not sent yet (IN-13). */
export class UpdateQueuedMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      attachments: AttachmentStore;
      images: ImageSettings;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `QueuedMessageNotFound`, or, for the images,
   * `ImagesNotSupported`, `TooManyAttachments` or `UnknownAttachment`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    queuedId: string;
    patch: {
      text?: string;
      attachmentIds?: string[];
      page?: PageContext | null;
    };
  }): Promise<QueuedMessage> {
    const { sessions, queue } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    await bindAttachments(this.deps, session.id, input.patch.attachmentIds);
    return queue.update(session.id, input.queuedId, input.patch);
  }
}

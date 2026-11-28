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
import {
  assertOwner,
  EmptyMessage,
  QueuedMessageNotFound,
  type Principal,
  type QueuedMessage,
} from '../../domain';
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

/** The text and images the message would have after the patch. */
function afterPatch(
  current: QueuedMessage,
  patch: { text?: string; attachmentIds?: string[] },
): { text: string; attachmentIds: string[] } {
  return {
    text: patch.text !== undefined ? patch.text : current.text,
    attachmentIds:
      patch.attachmentIds !== undefined
        ? patch.attachmentIds
        : current.attachments.map(attachment => attachment.id),
  };
}

/** The user changes a queued message that was not sent yet (IN-13). */
export class UpdateQueuedMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      queue: QueuedMessageRepository;
      attachments: AttachmentStore;
      images: ImageSettings;
      entities: EntityReader;
      references: ReferenceSettings;
      logger?: Logger;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `QueuedMessageNotFound`, or, for the images,
   * `ImagesNotSupported`, `TooManyAttachments` or `UnknownAttachment`, or
   * `TooManyReferences`. `references` replaces all the references of the
   * message, read again with the credentials of this request. A
   * patch that would leave the message with no text and no image is refused
   * (`EmptyMessage`, 400): the body cannot see what is already stored, so the
   * result is checked here.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    queuedId: string;
    patch: {
      text?: string;
      attachmentIds?: string[];
      page?: PageContext | null;
      references?: ReferenceInput[];
    };
  }): Promise<QueuedMessage> {
    const { sessions, queue } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const current = (await queue.list(session.id)).find(
      message => message.id === input.queuedId,
    );
    if (!current) throw new QueuedMessageNotFound(input.queuedId);
    const next = afterPatch(current, input.patch);
    if (next.text.length === 0 && next.attachmentIds.length === 0) {
      throw new EmptyMessage();
    }
    await bindAttachments(this.deps, session.id, input.patch.attachmentIds);
    const { references, ...patch } = input.patch;
    return queue.update(session.id, input.queuedId, {
      ...patch,
      ...(references !== undefined && {
        references: await resolveReferences(
          this.deps,
          input.principal,
          references,
        ),
      }),
    });
  }
}

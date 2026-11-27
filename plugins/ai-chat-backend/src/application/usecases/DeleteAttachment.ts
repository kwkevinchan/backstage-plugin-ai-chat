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

import { assertOwner, type Principal } from '../../domain';
import type { AttachmentStore, AuditLog, SessionRepository } from '../ports';

/** The owner deletes a pending (unused, unreserved) image from a session. */
export class DeleteAttachment {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      attachments: AttachmentStore;
      audit: AuditLog;
    },
  ) {}

  /**
   * Throws `NotSessionOwner`, `AttachmentNotFound` (missing, in another
   * session, or owned by someone else), or `AttachmentInUse` (already used by
   * a message or held by a queued message).
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    attachmentId: string;
  }): Promise<void> {
    const { sessions, attachments, audit } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const span = await audit.begin({
      eventId: 'attachment-delete',
      actorRef: input.principal.userRef,
      sessionId: session.id,
      attachmentId: input.attachmentId,
    });
    try {
      await attachments.deletePending({
        sessionId: session.id,
        id: input.attachmentId,
        ownerRef: input.principal.userRef,
      });
      await span.success();
    } catch (error) {
      await span.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

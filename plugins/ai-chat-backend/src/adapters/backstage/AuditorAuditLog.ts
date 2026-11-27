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

import type { AuditorService } from '@backstage/backend-plugin-api';
import type { AuditEvent, AuditLog, AuditSpan } from '../../application/ports';

/**
 * The audit log in the auditor of Backstage (O-02). The user goes into the
 * metadata: the auditor reads the actor from an HTTP request, and the loop
 * runs outside of the request that started it.
 */
export class AuditorAuditLog implements AuditLog {
  constructor(private readonly auditor: AuditorService) {}

  async begin(event: AuditEvent): Promise<AuditSpan> {
    const started = await this.auditor.createEvent({
      eventId: event.eventId,
      severityLevel: 'medium',
      meta: metaOf(event),
    });
    return {
      success: () => started.success(),
      fail: message => started.fail({ error: new Error(message) }),
    };
  }
}

function metaOf(event: AuditEvent) {
  switch (event.eventId) {
    case 'queued-message-send':
      return {
        actor: event.actorRef,
        sessionId: event.sessionId,
        runId: event.runId,
        queuedMessageId: event.queuedMessageId,
      };
    case 'session-share':
    case 'session-share-update':
    case 'session-share-revoke':
      return {
        actor: event.actorRef,
        sessionId: event.sessionId,
        shareId: event.shareId,
        subjectRef: event.subjectRef,
        mode: event.mode,
        upToSeq: event.upToSeq ?? null,
        outputsUpToSeq: event.outputsUpToSeq ?? null,
        expiresAt: event.expiresAt ?? null,
      };
    case 'session-fork':
      return {
        actor: event.actorRef,
        sourceSessionId: event.sourceSessionId,
        sessionId: event.sessionId,
        copiedItems: event.copiedItems,
        copiedAttachments: event.copiedAttachments,
      };
    default:
      return {
        actor: event.actorRef,
        sessionId: event.sessionId,
        runId: event.runId,
        toolCallId: event.callId,
        actionId: event.toolId,
        readOnly: event.readOnly,
      };
  }
}

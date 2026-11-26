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

import type { Clock, ItemLog } from '@kwkevinchan/ai-chat-harness';
import { isShareExpired, shareModeOf, type Share } from '../domain';
import type { AuditLog, ShareAuditEvent } from './ports';

/** A share as its owner sees it. */
export type ShareView = {
  share: Share;
  /** A live share past `expiresAt`: a snapshot frozen at that time (SH-11). */
  expired: boolean;
};

export function shareViewOf(share: Share, clock: Clock): ShareView {
  return {
    share,
    expired: isShareExpired(share, clock.now().toISOString()),
  };
}

/** The latest seq of the log; 0 for an empty log. */
export async function latestSeq(
  items: ItemLog,
  sessionId: string,
): Promise<number> {
  const log = await items.read(sessionId);
  return log.length === 0 ? 0 : log[log.length - 1].seq;
}

/** The audit event of a share, with the fields it has after the change. */
export function shareAuditEvent(
  eventId: ShareAuditEvent['eventId'],
  actorRef: string,
  share: Pick<
    Share,
    | 'id'
    | 'sessionId'
    | 'subjectRef'
    | 'upToSeq'
    | 'outputsUpToSeq'
    | 'expiresAt'
  >,
): ShareAuditEvent {
  return {
    eventId,
    actorRef,
    sessionId: share.sessionId,
    shareId: share.id,
    subjectRef: share.subjectRef,
    mode: shareModeOf(share),
    ...(share.upToSeq !== undefined && { upToSeq: share.upToSeq }),
    ...(share.outputsUpToSeq !== undefined && {
      outputsUpToSeq: share.outputsUpToSeq,
    }),
    ...(share.expiresAt !== undefined && { expiresAt: share.expiresAt }),
  };
}

/**
 * Records the event, then writes (SH-06). A failed record stops the write.
 * A write that fails, or finds the share cancelled (`undefined`), ends the
 * event as failed; the second case throws `missing()`.
 */
export async function auditedShareWrite(
  audit: AuditLog,
  event: ShareAuditEvent,
  write: () => Promise<Share | undefined>,
  missing: () => Error,
): Promise<Share> {
  const span = await audit.begin(event);
  let written: Share | undefined;
  try {
    written = await write();
  } catch (error) {
    await span.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (written === undefined) {
    await span.fail('The share is cancelled');
    throw missing();
  }
  await span.success();
  return written;
}

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

import type { Share } from '../domain';
import type { AuditLog, ShareAuditEvent } from './ports';
import { auditedShareWrite, shareAuditEvent } from './shareChanges';

const share: Share = {
  id: 'sh1',
  sessionId: 's1',
  subjectRef: 'user:default/bob',
  upToSeq: 3,
  createdBy: 'user:default/jane',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function recording() {
  const calls: string[] = [];
  const audit: AuditLog = {
    begin: async (event: ShareAuditEvent) => {
      calls.push(`begin ${event.eventId}`);
      return {
        success: async () => {
          calls.push('success');
        },
        fail: async (message: string) => {
          calls.push(`fail ${message}`);
        },
      };
    },
  } as AuditLog;
  return { audit, calls };
}

const event = shareAuditEvent(
  'session-share-revoke',
  'user:default/jane',
  share,
);

describe('auditedShareWrite', () => {
  it('records the event before the write and ends it as a success', async () => {
    const { audit, calls } = recording();
    const written = await auditedShareWrite(
      audit,
      event,
      async () => {
        calls.push('write');
        return share;
      },
      () => new Error('missing'),
    );
    expect(written).toBe(share);
    expect(calls).toEqual(['begin session-share-revoke', 'write', 'success']);
  });

  it('ends the event as failed and throws when the share was cancelled meanwhile', async () => {
    const { audit, calls } = recording();
    await expect(
      auditedShareWrite(
        audit,
        event,
        async () => undefined,
        () => new Error('missing'),
      ),
    ).rejects.toThrow('missing');
    expect(calls).toEqual([
      'begin session-share-revoke',
      'fail The share is cancelled',
    ]);
  });

  it('ends the event as failed and rethrows when the write fails', async () => {
    const { audit, calls } = recording();
    await expect(
      auditedShareWrite(
        audit,
        event,
        async () => {
          throw new Error('database down');
        },
        () => new Error('missing'),
      ),
    ).rejects.toThrow('database down');
    expect(calls).toEqual(['begin session-share-revoke', 'fail database down']);
  });

  it('does not write when the event cannot be recorded', async () => {
    const write = jest.fn();
    const audit: AuditLog = {
      begin: async () => {
        throw new Error('auditor down');
      },
    };
    await expect(
      auditedShareWrite(audit, event, write, () => new Error('missing')),
    ).rejects.toThrow('auditor down');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('shareAuditEvent', () => {
  it('names the share, its mode and the fields it has', () => {
    expect(event).toEqual({
      eventId: 'session-share-revoke',
      actorRef: 'user:default/jane',
      sessionId: 's1',
      shareId: 'sh1',
      subjectRef: 'user:default/bob',
      mode: 'snapshot',
      upToSeq: 3,
    });
  });
});

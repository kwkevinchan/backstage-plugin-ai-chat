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

import { mockServices } from '@backstage/backend-test-utils';
import { AuditorAuditLog } from '../adapters/backstage/AuditorAuditLog';
import {
  NEW_SESSION,
  createPersistence,
} from '../adapters/persistence/__testUtils__';
import { PurgeExpiredSessions } from '../application';
import { SessionNotFound } from '../domain';

describe('PurgeExpiredSessions (SE-05)', () => {
  it('deletes an expired session and leaves the audit events recorded for it', async () => {
    const stored = await createPersistence();
    try {
      const events: unknown[] = [];
      const auditor = mockServices.auditor.mock({
        createEvent: jest.fn(async options => {
          events.push(options);
          return { success: async () => {}, fail: async () => {} };
        }),
      });
      const session = await stored.sessions.create(NEW_SESSION);
      // The auditor keeps this outside the session tables. Purging the
      // session must not call the auditor again, and must not drop it.
      await new AuditorAuditLog(auditor).begin({
        eventId: 'tool-call-approve',
        actorRef: session.ownerRef,
        sessionId: session.id,
        runId: 'r1',
        callId: 'c1',
        toolId: 'demo:write',
        readOnly: false,
      });
      const recorded = [...events];
      await stored
        .knex('sessions')
        .where({ id: session.id })
        .update({ updated_at: '2020-01-01T00:00:00.000Z' });

      expect(
        await new PurgeExpiredSessions({
          sessions: stored.sessions,
          clock: stored.clock,
          retentionDays: 90,
        }).execute(),
      ).toBe(1);

      expect(events).toEqual(recorded);
      expect(auditor.createEvent).toHaveBeenCalledTimes(1);
      await expect(stored.sessions.get(session.id)).rejects.toBeInstanceOf(
        SessionNotFound,
      );
    } finally {
      await stored.cleanup();
    }
  });
});

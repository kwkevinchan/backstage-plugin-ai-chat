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
import { AuditorAuditLog } from './AuditorAuditLog';

describe('AuditorAuditLog', () => {
  it('creates an auditor event with the user and the call, and ends it', async () => {
    const success = jest.fn();
    const fail = jest.fn();
    const auditor = mockServices.auditor.mock({
      createEvent: jest.fn(async () => ({ success, fail })),
    });
    const log = new AuditorAuditLog(auditor);
    const span = await log.begin({
      eventId: 'tool-call-approve',
      actorRef: 'user:default/jane',
      sessionId: 's1',
      runId: 'r1',
      callId: 'c1',
      toolId: 'demo:write',
      readOnly: false,
    });
    expect(auditor.createEvent).toHaveBeenCalledWith({
      eventId: 'tool-call-approve',
      severityLevel: 'medium',
      meta: {
        actor: 'user:default/jane',
        sessionId: 's1',
        runId: 'r1',
        toolCallId: 'c1',
        actionId: 'demo:write',
        readOnly: false,
      },
    });
    await span.success();
    expect(success).toHaveBeenCalled();
    await span.fail('nope');
    expect(fail).toHaveBeenCalledWith({ error: new Error('nope') });
  });
});

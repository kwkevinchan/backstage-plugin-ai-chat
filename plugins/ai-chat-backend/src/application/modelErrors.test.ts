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

import { errorLogFields, errorStatusOf } from './modelErrors';
import { AuditedToolGateway } from './AuditedToolGateway';

describe('errorLogFields', () => {
  it('extracts name, short code, and HTTP status while omitting error.message', () => {
    const secret = 'TOP_SECRET_USER_PROMPT_12345';
    const err = Object.assign(new TypeError(`boom: ${secret}`), {
      code: 'ECONNREFUSED',
      status: 502,
    });

    const fields = errorLogFields(err);
    expect(fields).toEqual({
      errorName: 'TypeError',
      errorCode: 'ECONNREFUSED',
      errorStatus: 502,
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it('drops non-code strings (whitespace or overly long) and out-of-range statuses', () => {
    const err = Object.assign(new Error('secret'), {
      code: 'contains spaces like a message',
      status: 999,
    });
    expect(errorLogFields(err)).toEqual({ errorName: 'Error' });
    expect(errorLogFields({ code: 'x'.repeat(65) })).toEqual({
      errorName: 'object',
    });
    expect(errorStatusOf({ status: 42 })).toBeUndefined();
  });

  it('handles non-Error thrown values without leaking their string content', () => {
    const secret = 'RAW_THROWN_SECRET_VALUE';
    const fields = errorLogFields(secret);
    expect(fields).toEqual({ errorName: 'string' });
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it('does not leak error.message into logger meta when AuditedToolGateway fails to close audit', async () => {
    const secret = 'SENSITIVE_TOOL_PAYLOAD_XYZ';
    const warn = jest.fn();
    const gateway = new AuditedToolGateway(
      {
        list: jest.fn(),
        validate: jest.fn(),
        execute: jest.fn(async () => ({ status: 'ok' as const, output: {} })),
      },
      {
        begin: jest.fn(async () => ({
          success: jest.fn(async () => {
            throw Object.assign(new Error(`audit error: ${secret}`), {
              code: 'AUDIT_WRITE_FAILED',
            });
          }),
          fail: jest.fn(),
        })),
      },
      {
        info: jest.fn(),
        warn,
        error: jest.fn(),
      },
    );

    await gateway.execute(
      {
        sessionId: 's1',
        seq: 1,
        createdAt: '2026-11-26T00:00:00.000Z',
        kind: 'tool_call',
        callId: 'c1',
        toolId: 'demo:write',
        input: {},
        schemaHash: 'h',
        policy: 'ask',
        readOnly: false,
        step: 0,
        position: 0,
      },
      {
        sessionId: 's1',
        runId: 'r1',
        principal: { userRef: 'user:default/jane' },
      },
      { signal: new AbortController().signal },
    );

    expect(warn).toHaveBeenCalledWith('Could not end an audit record', {
      errorName: 'Error',
      errorCode: 'AUDIT_WRITE_FAILED',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });
});

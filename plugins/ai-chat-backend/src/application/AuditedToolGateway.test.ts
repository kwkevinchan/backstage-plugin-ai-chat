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

import {
  FakeToolGateway,
  type FakeTool,
} from '@kwkevinchan/ai-chat-harness/testing';
import type { ToolCallItem } from '@kwkevinchan/ai-chat-harness';
import { AuditedToolGateway } from './AuditedToolGateway';
import type { AuditEvent, AuditLog } from './ports';

const tool = (id: string, readOnly: boolean, extra: Partial<FakeTool> = {}) =>
  ({
    descriptor: {
      id,
      description: id,
      inputSchema: { type: 'object' },
      schemaHash: 'h',
      readOnly,
    },
    ...extra,
  } as FakeTool);

const call = (toolId: string, readOnly: boolean) =>
  ({
    kind: 'tool_call',
    callId: 'c1',
    toolId,
    input: {},
    readOnly,
  } as unknown as ToolCallItem);

const ctx = {
  sessionId: 's1',
  runId: 'r1',
  principal: { userRef: 'user:default/jane' },
};

function setup(tools: FakeTool[], broken = false) {
  const events: (AuditEvent & { outcome?: string })[] = [];
  const audit: AuditLog = {
    async begin(event) {
      const record: AuditEvent & { outcome?: string } = { ...event };
      events.push(record);
      return {
        success: async () => {
          if (broken) throw new Error('auditor down');
          record.outcome = 'success';
        },
        fail: async message => {
          if (broken) throw new Error('auditor down');
          record.outcome = `fail: ${message}`;
        },
      };
    },
  };
  const inner = new FakeToolGateway(tools);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    events,
    logger,
    gateway: new AuditedToolGateway(inner, audit, logger),
    inner,
  };
}

const opts = { signal: new AbortController().signal };

describe('AuditedToolGateway (O-02)', () => {
  it('records the run of a tool that is not read-only, with the user', async () => {
    const { events, gateway, inner } = setup([tool('a:write', false)]);
    await gateway.execute(call('a:write', false), ctx, opts);
    expect(inner.executed).toHaveLength(1);
    expect(events).toEqual([
      {
        eventId: 'tool-call-invoke',
        actorRef: 'user:default/jane',
        sessionId: 's1',
        runId: 'r1',
        callId: 'c1',
        toolId: 'a:write',
        readOnly: false,
        outcome: 'success',
      },
    ]);
  });

  it('does not record a read-only tool', async () => {
    const { events, gateway } = setup([tool('a:read', true)]);
    await gateway.execute(call('a:read', true), ctx, opts);
    expect(events).toEqual([]);
  });

  it('records a failure when the tool gives an error or throws', async () => {
    const { events, gateway } = setup([
      tool('a:err', false, {
        execute: () => ({ status: 'error', message: 'no' }),
      }),
      tool('a:throw', false, {
        execute: () => {
          throw new Error('boom');
        },
      }),
    ]);
    await gateway.execute(call('a:err', false), ctx, opts);
    await expect(
      gateway.execute(call('a:throw', false), ctx, opts),
    ).rejects.toThrow('boom');
    expect(events.map(e => e.outcome)).toEqual([
      'fail: The tool ended with status error',
      'fail: boom',
    ]);
  });

  it('only logs when the audit record cannot be ended: the result of the tool stays', async () => {
    const { gateway, logger } = setup(
      [
        tool('a:write', false),
        tool('a:err', false, {
          execute: () => ({ status: 'error', message: 'no' }),
        }),
        tool('a:throw', false, {
          execute: () => {
            throw new Error('boom');
          },
        }),
      ],
      true,
    );
    expect(await gateway.execute(call('a:write', false), ctx, opts)).toEqual({
      status: 'ok',
      output: {},
    });
    expect(
      await gateway.execute(call('a:err', false), ctx, opts),
    ).toMatchObject({ status: 'error' });
    // The error of the tool itself still reaches the loop.
    await expect(
      gateway.execute(call('a:throw', false), ctx, opts),
    ).rejects.toThrow('boom');
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

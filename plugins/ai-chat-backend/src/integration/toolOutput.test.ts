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

import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { callTool, say } from '@kwkevinchan/ai-chat-harness/testing';
import type { Item } from '@kwkevinchan/ai-chat-harness';
import express from 'express';
import request from 'supertest';
import { AiChatHarnessRegistry } from '../adapters/backstage/AiChatHarnessRegistry';
import { principalFromRequest } from '../adapters/backstage/principalFromRequest';
import { createRouter } from '../adapters/http';
import { parseSse } from '../adapters/http/__testUtils__/uiMessageStream';
import type { ToolOutputRule } from '../domain';
import { createWorld, drain, jane, testInputConfig } from './__testUtils__';

const JANE = mockCredentials.user.header('user:default/jane');
const SECRET = 'sk-test-secret-value';

describe('the limits and the fields to hide of the output of an action (T-09)', () => {
  let world: Awaited<ReturnType<typeof createWorld>>;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  async function start(
    toolOutput: ToolOutputRule[],
    extra: { maxToolOutputChars?: number } = {},
  ) {
    world = await createWorld({ toolOutput, ...extra });
  }

  /** What the fake action gives back. */
  function answer(id: string, output: unknown) {
    (world.actions.actions.find(a => a.id === id) as any).output = output;
  }

  afterEach(async () => {
    for (const supervisor of open.splice(0)) await supervisor.shutdown(0);
    await world.cleanup();
  });

  function backend(...args: Parameters<typeof world.backend>) {
    const b = world.backend(...args);
    open.push(b.supervisor);
    const application = express()
      .use(
        createRouter({
          principal: req =>
            principalFromRequest(req, {
              httpAuth: mockServices.httpAuth(),
              userInfo: mockServices.userInfo(),
              auth: mockServices.auth(),
            }),
          useCases: b.useCases,
          inputConfig: testInputConfig,
          logger: b.logger,
        }),
      )
      .use(
        MiddlewareFactory.create({
          config: mockServices.rootConfig(),
          logger: mockServices.rootLogger(),
        }).error(),
      );
    return { ...b, app: application };
  }

  const results = async (sessionId: string) =>
    (await world.items.read(sessionId)).filter(
      (item): item is Item & { kind: 'tool_result' } =>
        item.kind === 'tool_result',
    );

  it('a hidden value is not in the log, the stream, the session or the next input of the model', async () => {
    await start([{ pattern: 'demo:*', redact: ['token'] }]);
    answer('demo:read', {
      token: SECRET,
      things: [{ name: 'a', token: SECRET }],
    });
    const b = backend([
      [callTool('m1', 'demo:read', { name: 'r' })],
      [say('Done.')],
    ]);
    const id = (
      await request(b.app).post('/sessions').set('Authorization', JANE)
    ).body.id;
    const res = await request(b.app)
      .post(`/sessions/${id}/runs`)
      .set('Authorization', JANE)
      .send({ text: 'go' })
      .expect(200);
    expect(res.text).not.toContain(SECRET);
    const [stored] = await results(id);
    expect(stored).toMatchObject({
      status: 'ok',
      output: {
        token: '[redacted]',
        things: [{ name: 'a', token: '[redacted]' }],
      },
    });
    // The stream shows the stored output.
    const chunks = await parseSse(res.text);
    const streamed = chunks.find(c => c.type === 'tool-output-available') as
      | { output?: unknown }
      | undefined;
    expect(streamed?.output).toEqual(stored.output);

    const session = await request(b.app)
      .get(`/sessions/${id}`)
      .set('Authorization', JANE)
      .expect(200);
    expect(JSON.stringify(session.body)).not.toContain(SECRET);
    expect(JSON.stringify(b.model.inputs[1])).not.toContain(SECRET);
    expect(JSON.stringify(b.model.inputs[1])).toContain('[redacted]');
  });

  it('each action has its limit, and the others keep the limit of the installation', async () => {
    await start([{ pattern: 'demo:read', maxOutputChars: 150, redact: [] }], {
      maxToolOutputChars: 1000,
    });
    answer('demo:read', { text: 'a'.repeat(500) });
    answer('demo:write', { text: 'b'.repeat(500) });
    const b = backend([
      [callTool('m1', 'demo:read', { name: 'r' })],
      [callTool('m2', 'demo:write', { name: 'w' })],
      [say('Done.')],
    ]);
    const session = await world.newSession();
    const first = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    const [pending] = (first[first.length - 1] as any).outcome.pending;
    await drain(
      (
        await b.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId: pending.callId,
          decision: 'allow',
        })
      ).run!,
    );
    const [read, write] = await results(session.id);
    expect(read).toMatchObject({ status: 'ok', truncated: true });
    expect(JSON.stringify(read.output).length).toBeLessThanOrEqual(150);
    expect(write).toMatchObject({
      status: 'ok',
      output: { text: 'b'.repeat(500) },
    });
    expect(write.truncated).toBeUndefined();
  });

  it('read-only calls that run at the same time are each hidden, and written in order', async () => {
    await start([{ pattern: '*', redact: ['token'] }]);
    answer('demo:read', { token: SECRET, n: 1 });
    const b = backend([
      [
        callTool('m1', 'demo:read', { name: 'a' }),
        callTool('m2', 'demo:read', { name: 'b' }),
        callTool('m3', 'demo:read', { name: 'c' }),
      ],
      [say('Done.')],
    ]);
    const session = await world.newSession();
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    const items = await world.items.read(session.id);
    const calls = items.filter(i => i.kind === 'tool_call') as any[];
    const stored = await results(session.id);
    expect(stored.map(r => r.callId)).toEqual(calls.map(c => c.callId));
    for (const result of stored) {
      expect(result.output).toEqual({ token: '[redacted]', n: 1 });
    }
  });

  it('after an afterToolCall hook, the output is hidden and cut again by the rules of its action', async () => {
    const toolOutput = [
      { pattern: '*', redact: ['token'] },
      { pattern: 'demo:read', maxOutputChars: 200, redact: [] },
    ];
    await start(toolOutput);
    answer('demo:read', { token: SECRET });
    const seen: unknown[] = [];
    const registry = new AiChatHarnessRegistry();
    registry.addHook('afterToolCall', (_call, result) => {
      seen.push(result.output);
      return {
        ...result,
        output: { token: SECRET, padding: 'x'.repeat(500) },
      };
    });
    const b = backend(
      [[callTool('m1', 'demo:read', { name: 'r' })], [say('Done.')]],
      {
        extensions: registry.extensions({
          logger: mockServices.logger.mock(),
          maxToolOutputChars: 20000,
          toolOutput,
        }),
      },
    );
    const session = await world.newSession();
    const events = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    expect(seen).toEqual([{ token: '[redacted]' }]);
    const [stored] = await results(session.id);
    expect(stored).toMatchObject({ status: 'ok', truncated: true });
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored.output).length).toBeLessThanOrEqual(200);
    const streamed = events.find(
      e => e.type === 'item.completed' && e.item.kind === 'tool_result',
    );
    expect((streamed as { item: unknown }).item).toEqual(stored);
  });

  it('a change whose output is too deep to check: an error result without output, not unknown, and it ran once', async () => {
    await start([{ pattern: '*', redact: ['token'] }]);
    let deep: unknown = { token: SECRET };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    answer('demo:write', deep);
    const b = backend([
      [callTool('m1', 'demo:write', { name: 'w' })],
      [say('Done.')],
    ]);
    const session = await world.newSession();
    const first = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    const [pending] = (first[first.length - 1] as any).outcome.pending;
    const events = await drain(
      (
        await b.useCases.decideApproval.execute({
          principal: jane,
          sessionId: session.id,
          callId: pending.callId,
          decision: 'allow',
        })
      ).run!,
    );
    expect(events[events.length - 1]).toMatchObject({
      outcome: { status: 'completed' },
    });
    const [stored] = await results(session.id);
    expect(stored).toEqual(
      expect.objectContaining({
        status: 'error',
        message:
          'The output could not be checked for redaction, so it is not kept.',
      }),
    );
    expect(stored).not.toHaveProperty('output');
    expect(world.actions.count('demo:write')).toBe(1);
  });

  it('without toolOutput, the output is kept as it is', async () => {
    await start([]);
    answer('demo:read', { token: SECRET });
    const b = backend([
      [callTool('m1', 'demo:read', { name: 'r' })],
      [say('Done.')],
    ]);
    const session = await world.newSession();
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    const [stored] = await results(session.id);
    expect(stored.output).toEqual({ token: SECRET });
  });
});

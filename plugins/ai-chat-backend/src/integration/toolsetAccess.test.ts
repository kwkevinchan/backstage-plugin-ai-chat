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

import type { PermissionsService } from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import {
  AuthorizeResult,
  type PolicyDecision,
} from '@backstage/plugin-permission-common';
import { createConditionAuthorizer } from '@backstage/plugin-permission-node';
import { callTool, say } from '@kwkevinchan/ai-chat-harness/testing';
import { aiChatToolsetUsePermission } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import express from 'express';
import request from 'supertest';
import { PermissionAccessControl } from '../adapters/backstage/PermissionAccessControl';
import { principalFromRequest } from '../adapters/backstage/principalFromRequest';
import { isSessionOwnerRule } from '../adapters/backstage/sessionAccess';
import {
  aiChatToolsetConditions,
  createAiChatToolsetConditionalDecision,
  isToolsetRule,
} from '../adapters/backstage/toolsetAccess';
import { createRouter } from '../adapters/http';
import type { Item } from '@kwkevinchan/ai-chat-harness';
import {
  createWorld,
  drain,
  jane,
  mallory,
  testInputConfig,
} from './__testUtils__';

const JANE = mockCredentials.user.header('user:default/jane');
const MALLORY = mockCredentials.user.header('user:default/mallory');

/** Two toolsets: the read of `demo`, and its two changes. */
const toolsets = {
  reads: { actions: ['demo:read'], default: true },
  writes: { actions: ['demo:write*'], default: true },
};

const only = (...toolsetIds: string[]) =>
  createAiChatToolsetConditionalDecision(
    aiChatToolsetUsePermission,
    aiChatToolsetConditions.isToolset({ toolsetIds }),
  );

/**
 * The permission framework on a policy of the test: `decide` gives the
 * decision of `ai-chat.toolset.use` for a user. Reading a session is left to
 * the owner and the shares (ALLOW).
 */
function permissionsOf(decide: (userRef: string) => PolicyDecision) {
  const permissions = {
    authorize: async () => [{ result: AuthorizeResult.DENY }],
    authorizeConditional: async (
      requests: { permission: { name: string } }[],
      options: { credentials: any },
    ) => {
      if (requests[0].permission.name !== aiChatToolsetUsePermission.name) {
        return [{ result: AuthorizeResult.ALLOW }];
      }
      return [decide(options.credentials.principal.userEntityRef)];
    },
  } as unknown as PermissionsService;
  return new PermissionAccessControl({
    permissions,
    authorizer: createConditionAuthorizer([isSessionOwnerRule]),
    toolsetAuthorizer: createConditionAuthorizer([isToolsetRule]),
  });
}

const toolIds = (input: { tools: { id: string }[] }) =>
  input.tools.map(tool => tool.id).sort();

describe('who may use which toolset (T-08)', () => {
  let world: Awaited<ReturnType<typeof createWorld>>;
  let decide: (userRef: string) => PolicyDecision;
  const open: { shutdown(ms?: number): Promise<void> }[] = [];

  async function start(
    options: Omit<Parameters<typeof createWorld>[0] & object, 'access'> = {},
  ) {
    world = await createWorld({
      toolsets,
      ...options,
      access: permissionsOf(userRef => decide(userRef)),
    });
  }

  beforeEach(() => {
    decide = () => ({ result: AuthorizeResult.ALLOW });
  });

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

  const as = (user: string, test: request.Test) =>
    test.set('Authorization', user);

  it('ALLOW, as when the framework is off: every toolset, and the model gets every tool', async () => {
    await start();
    const b = backend([[say('hi')]]);
    const list = await as(JANE, request(b.app).get('/toolsets')).expect(200);
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([
      'reads',
      'writes',
    ]);
    const session = await world.newSession(jane);
    expect(session.enabledToolsets).toEqual(['reads', 'writes']);
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    expect(toolIds(b.model.inputs[0])).toEqual([
      'demo:read',
      'demo:write',
      'demo:write2',
      'update_plan',
    ]);
  });

  it('DENY: only the built-in tools go to the model and are listed, and no toolset is listed', async () => {
    await start();
    decide = () => ({ result: AuthorizeResult.DENY });
    const b = backend([[say('hi')]]);
    const id = (await as(JANE, request(b.app).post('/sessions')).expect(201))
      .body.id;
    const list = await as(JANE, request(b.app).get('/toolsets')).expect(200);
    expect(list.body.items).toEqual([]);
    const tools = await as(
      JANE,
      request(b.app).get(`/sessions/${id}/tools`),
    ).expect(200);
    expect(tools.body.items.map((t: { id: string }) => t.id)).toEqual([
      'update_plan',
    ]);
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: id,
        text: 'go',
      }),
    );
    expect(toolIds(b.model.inputs[0])).toEqual(['update_plan']);
  });

  it('CONDITIONAL: two users of one configuration get different tools', async () => {
    await start();
    decide = userRef =>
      userRef === jane.userRef
        ? { result: AuthorizeResult.ALLOW }
        : only('reads');
    const b = backend([[say('a')], [say('b')]]);
    const mine = await world.newSession(jane);
    const theirs = await world.newSession(mallory);
    expect(theirs.enabledToolsets).toEqual(['reads']);
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: mine.id,
        text: 'go',
      }),
    );
    await drain(
      await b.useCases.sendMessage.execute({
        principal: mallory,
        sessionId: theirs.id,
        text: 'go',
      }),
    );
    expect(toolIds(b.model.inputs[0])).toEqual([
      'demo:read',
      'demo:write',
      'demo:write2',
      'update_plan',
    ]);
    expect(toolIds(b.model.inputs[1])).toEqual(['demo:read', 'update_plan']);
  });

  it('an action in a usable toolset is offered although another toolset of it is not usable', async () => {
    await start({
      toolsets: {
        ...toolsets,
        everything: { actions: ['demo:*'], default: true },
      },
    });
    decide = () => only('reads', 'everything');
    const b = backend([[say('a')]]);
    const session = await world.newSession(jane);
    expect(session.enabledToolsets).toEqual(['reads', 'everything']);
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    expect(toolIds(b.model.inputs[0])).toContain('demo:write');
  });

  it('a call of a tool the user may not use is invalid: no approval card, the action does not run', async () => {
    await start();
    decide = () => only('reads');
    const b = backend([
      [callTool('m1', 'demo:write', { name: 'x' })],
      [say('done')],
    ]);
    const session = await world.newSession(jane);
    const events = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    expect(events[events.length - 1]).toMatchObject({
      outcome: { status: 'completed' },
    });
    const items = await world.items.read(session.id);
    expect(items.find(i => i.kind === 'tool_result')).toMatchObject({
      status: 'invalid',
    });
    expect(items.some(i => i.kind === 'approval')).toBe(false);
    expect(world.actions.count('demo:write')).toBe(0);
  });

  it('a permission taken back while a call waits for approval: it does not run after the approval, and the run goes on', async () => {
    await start();
    const b = backend([
      [callTool('m1', 'demo:write', { name: 'x' })],
      [say('done')],
    ]);
    const session = await world.newSession(jane);
    const first = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    const [pending] = (first[first.length - 1] as any).outcome
      .pending as Item[];
    decide = () => only('reads');
    const decided = await b.useCases.decideApproval.execute({
      principal: jane,
      sessionId: session.id,
      callId: (pending as any).callId,
      decision: 'allow',
    });
    const events = await drain(decided.run!);
    expect(events[events.length - 1]).toMatchObject({
      outcome: { status: 'completed' },
    });
    const items = await world.items.read(session.id);
    expect(items.find(i => i.kind === 'tool_result')).toMatchObject({
      status: 'error',
      message: 'The tool demo:write is not available.',
    });
    expect(world.actions.count('demo:write')).toBe(0);
  });

  it('a new session takes no toolset the user may not use: 400 when named, left out of the defaults', async () => {
    await start();
    decide = () => only('reads');
    const b = backend([]);
    await as(JANE, request(b.app).post('/sessions'))
      .send({ enabledToolsets: ['writes'] })
      .expect(400);
    const created = await as(JANE, request(b.app).post('/sessions')).expect(
      201,
    );
    expect(created.body.enabledToolsets).toEqual(['reads']);
  });

  it('a change of the toolsets: a toolset added that the user may not use is 400; one the session has stays and gives no tools', async () => {
    await start();
    const b = backend([[say('a')]]);
    const id = (await as(JANE, request(b.app).post('/sessions')).expect(201))
      .body.id;
    await as(JANE, request(b.app).patch(`/sessions/${id}`))
      .send({ enabledToolsets: ['reads'] })
      .expect(200);
    decide = () => only('reads');
    await as(JANE, request(b.app).patch(`/sessions/${id}`))
      .send({ enabledToolsets: ['reads', 'writes'] })
      .expect(400);

    // Back to both while the user may use both, then the permission goes.
    decide = () => ({ result: AuthorizeResult.ALLOW });
    await as(JANE, request(b.app).patch(`/sessions/${id}`))
      .send({ enabledToolsets: ['reads', 'writes'] })
      .expect(200);
    decide = () => only('reads');
    const kept = await as(JANE, request(b.app).patch(`/sessions/${id}`))
      .send({ enabledToolsets: ['reads', 'writes'] })
      .expect(200);
    expect(kept.body.enabledToolsets).toEqual(['reads', 'writes']);
    await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: id,
        text: 'go',
      }),
    );
    expect(toolIds(b.model.inputs[0])).toEqual(['demo:read', 'update_plan']);
  });

  it('the toolsets of the agent (X-01): only the ones it names, none for an empty list, all without the field', async () => {
    await start({
      agents: {
        narrow: { toolsets: ['reads'] },
        bare: { toolsets: [] },
      },
    });
    const b = backend([[say('a')], [say('b')], [say('c')]]);
    for (const agentId of ['narrow', 'bare', 'default']) {
      const session = await world.newSession(jane, agentId);
      expect(session.enabledToolsets).toEqual(['reads', 'writes']);
      await drain(
        await b.useCases.sendMessage.execute({
          principal: jane,
          sessionId: session.id,
          text: 'go',
        }),
      );
    }
    expect(b.model.inputs.map(toolIds)).toEqual([
      ['demo:read', 'update_plan'],
      ['update_plan'],
      ['demo:read', 'demo:write', 'demo:write2', 'update_plan'],
    ]);
  });

  it('a failure of the permission backend allows nothing: the run fails before the model is called, and the toolsets are not listed', async () => {
    await start();
    const b = backend([[say('never')]]);
    const session = await world.newSession(jane);
    decide = () => {
      throw new Error('permission backend is down');
    };
    const events = await drain(
      await b.useCases.sendMessage.execute({
        principal: jane,
        sessionId: session.id,
        text: 'go',
      }),
    );
    expect(events[events.length - 1]).toMatchObject({
      outcome: { status: 'failed' },
    });
    expect(b.model.inputs).toHaveLength(0);
    const res = await as(MALLORY, request(b.app).get('/toolsets'));
    expect(res.status).toBe(500);
  });
});

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
  createBackendModule,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import exampleModule from '@kwkevinchan/backstage-plugin-ai-chat-backend-module-example';
import { aiChatHarnessExtensionPoint } from '@kwkevinchan/backstage-plugin-ai-chat-node';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import knex from 'knex';
import request from 'supertest';
import { TITLE_PROMPT_MARK } from './application';
import {
  parseSse,
  readMessage,
} from './adapters/http/__testUtils__/uiMessageStream';
import {
  createDb,
  FakeActions,
  LlmServer,
  sseBody,
  startLlmServer,
} from './__testUtils__';
import { aiChatPlugin } from './plugin';

const chunk = (delta: unknown) => ({ choices: [{ index: 0, delta }] });
const text = (content: string) => sseBody([chunk({ content }), chunk({})]);
const call = (name: string, args: unknown) =>
  sseBody([
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
  ]);

describe('aiChatPlugin', () => {
  let llm: LlmServer;
  let answers: string[];
  let actions: FakeActions;
  let auditEvents: string[];

  afterEach(async () => {
    await llm?.close();
  });

  async function startBackend(
    respond?: Parameters<typeof startLlmServer>[0],
    features: Parameters<typeof startTestBackend>[0]['features'] = [],
  ) {
    answers = [];
    // A title call is not one of the scripted answers. It gets a fixed title
    // so the next step of the conversation still gets the answer it expects.
    let scripted = 0;
    llm = await startLlmServer(
      respond ??
        (body => {
          const system = body.messages?.find(
            (message: { role?: string }) => message.role === 'system',
          );
          const content = system?.content;
          if (
            typeof content === 'string' &&
            content.startsWith(TITLE_PROMPT_MARK)
          ) {
            return { body: text('Generated title') };
          }
          const index = scripted;
          scripted += 1;
          return {
            body: answers[Math.min(index, answers.length - 1)],
          };
        }),
    );
    actions = new FakeActions([
      { id: 'demo:list-things', readOnly: true, run: () => ({ things: [1] }) },
      { id: 'demo:change-thing', destructive: true },
    ]);
    auditEvents = [];
    const auditor = mockServices.auditor.mock({
      createEvent: async options => {
        auditEvents.push(options.eventId);
        return { success: async () => {}, fail: async () => {} };
      },
    });
    const { server } = await startTestBackend({
      features: [
        aiChatPlugin,
        ...features,
        mockServices.rootConfig.factory({
          data: {
            aiChat: { llm: { baseUrl: llm.url, model: 'test-model' } },
          },
        }),
        // The plugin runs its own migrations.
        mockServices.database.factory({ knex: await createDb() }),
        auditor.factory,
        // A request without credentials is a request of nobody.
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        createServiceFactory({
          service: actionsServiceRef,
          deps: {},
          factory: () => actions,
        }),
      ],
    });
    return server;
  }

  const alice = mockCredentials.user.header('user:default/alice');
  const bob = mockCredentials.user.header('user:default/bob');

  it('does not start when the SQLite pool allows more than one connection', async () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 2 },
      useNullAsDefault: true,
    });
    try {
      await expect(
        startTestBackend({
          features: [
            aiChatPlugin,
            mockServices.rootConfig.factory({
              data: {
                aiChat: {
                  llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' },
                },
              },
            }),
            mockServices.database.factory({ knex: db }),
            mockServices.auditor.mock().factory,
            mockServices.httpAuth.factory({
              defaultCredentials: mockCredentials.none(),
            }),
            createServiceFactory({
              service: actionsServiceRef,
              deps: {},
              factory: () => new FakeActions([]),
            }),
          ],
        }),
      ).rejects.toThrow(/one SQLite connection/);
    } finally {
      await db.destroy();
    }
  });

  it('schedules session retention every hour, and a retention of 0 deletes nothing', async () => {
    const scheduler = mockServices.scheduler.mock();
    const db = await createDb();
    try {
      await startTestBackend({
        features: [
          aiChatPlugin,
          mockServices.rootConfig.factory({
            data: {
              aiChat: {
                llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' },
                retention: { days: 0 },
              },
            },
          }),
          mockServices.database.factory({ knex: db }),
          mockServices.auditor.mock().factory,
          mockServices.httpAuth.factory({
            defaultCredentials: mockCredentials.none(),
          }),
          scheduler.factory,
          createServiceFactory({
            service: actionsServiceRef,
            deps: {},
            factory: () => new FakeActions([]),
          }),
        ],
      });
      const task = scheduler.scheduleTask.mock.calls
        .map(scheduled => scheduled[0])
        .find(options => options.id === 'ai-chat-purge-expired-sessions');
      expect(task).toMatchObject({
        frequency: { hours: 1 },
        timeout: { minutes: 5 },
      });
      if (!task) throw new Error('retention task was not scheduled');
      await db('sessions').insert({
        id: 'old-session',
        owner_ref: 'user:default/alice',
        agent_id: 'default',
        enabled_toolsets: '[]',
        pinned: false,
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
      });
      await task.fn(new AbortController().signal);
      expect(await db('sessions').where({ id: 'old-session' })).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  it('registers the session read permission and its rules', async () => {
    const server = await startBackend();
    const metadata = await request(server)
      .get('/api/ai-chat/.well-known/backstage/permissions/metadata')
      .set('Authorization', alice);
    expect(metadata.status).toBe(200);
    expect(metadata.body.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ai-chat.session.read' }),
      ]),
    );
    expect(
      metadata.body.rules.map((rule: { name: string }) => rule.name).sort(),
    ).toEqual(['IS_SESSION_OWNER', 'IS_SHARED_WITH']);
  });

  it('refuses a request without credentials (401) and a service token (403)', async () => {
    const server = await startBackend();
    const none = await request(server).get('/api/ai-chat/sessions');
    const service = await request(server)
      .get('/api/ai-chat/sessions')
      .set('Authorization', mockCredentials.service.header());
    expect([none.status, service.status]).toEqual([401, 403]);
  });

  it('creates, lists, reads and deletes sessions of the user only', async () => {
    const server = await startBackend();
    const created = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice)
      .expect(201);
    expect(created.body).toMatchObject({
      id: expect.any(String),
      ownerRef: 'user:default/alice',
      enabledToolsets: ['default'],
    });
    const id = created.body.id;

    const list = await request(server)
      .get('/api/ai-chat/sessions')
      .set('Authorization', alice)
      .expect(200);
    expect(list.body.items.map((s: any) => s.id)).toEqual([id]);
    const bobList = await request(server)
      .get('/api/ai-chat/sessions')
      .set('Authorization', bob)
      .expect(200);
    expect(bobList.body.items).toEqual([]);

    await request(server)
      .get(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', bob)
      .expect(404);
    await request(server)
      .delete(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', bob)
      .expect(404);
    const detail = await request(server)
      .get(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', alice)
      .expect(200);
    expect(detail.body).toMatchObject({
      session: { id },
      items: [],
      awaitingDecision: [],
      resumable: false,
    });
    await request(server)
      .delete(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', alice)
      .expect(204);
    await request(server)
      .get(`/api/ai-chat/sessions/${id}`)
      .set('Authorization', alice)
      .expect(404);
  });

  it('streams the answer of a message', async () => {
    const server = await startBackend();
    answers = [text('Hello there')];
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const res = await request(server)
      .post(`/api/ai-chat/sessions/${body.id}/runs`)
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
    const message = await readMessage(await parseSse(res.text));
    expect(message.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: 'Hello there', state: 'done' },
    ]);
    expect(llm.requests[0].body).toMatchObject({
      model: 'test-model',
      stream: true,
    });
  });

  it('answers a refused request with an error status, not a stream', async () => {
    const server = await startBackend();
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const url = `/api/ai-chat/sessions/${body.id}/runs`;
    await request(server)
      .post(url)
      .set('Authorization', alice)
      .send({ text: '' })
      .expect(400);
    const missing = await request(server)
      .post('/api/ai-chat/sessions/nope/runs')
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    await request(server)
      .post(url)
      .set('Authorization', bob)
      .send({ text: 'hi' })
      .expect(404);
  });

  it('runs a read-only action at once, and waits for approval of another', async () => {
    const server = await startBackend();
    answers = [
      call('demo_list-things', {}),
      text('One thing.'),
      call('demo_change-thing', { name: 'x' }),
      text('Changed.'),
    ];
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const base = `/api/ai-chat/sessions/${body.id}`;

    const first = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'list' });
    await readMessage(await parseSse(first.text));
    expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);

    const second = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'change x' });
    const chunks = await parseSse(second.text);
    const request1 = chunks.find(
      c => c.type === 'tool-approval-request',
    ) as any;
    expect(request1).toBeDefined();
    expect(actions.invocations).toHaveLength(1);
    const callId = request1.approvalId;

    // Someone else cannot decide.
    await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', bob)
      .send({ approved: true })
      .expect(404);
    expect(actions.invocations).toHaveLength(1);

    const approved = await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', alice)
      .send({ approved: true })
      .expect(200);
    const after = await parseSse(approved.text);
    expect(after.map(c => c.type)).toContain('tool-output-available');
    expect(after[after.length - 1]).toMatchObject({ type: 'finish' });
    expect(actions.invocations.map(i => [i.id, i.input])).toEqual([
      ['demo:list-things', {}],
      ['demo:change-thing', { name: 'x' }],
    ]);

    // Only once.
    const again = await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', alice)
      .send({ approved: true })
      .expect(200);
    expect(again.body).toEqual({ approved: true });
    expect(actions.invocations).toHaveLength(2);
    expect(auditEvents).toEqual(['tool-call-approve', 'tool-call-invoke']);
  });

  it('offers only update_plan in the first step of an agent with planning: required, then every tool, and streams the plan (X-06, X-07)', async () => {
    const server = await startBackend(undefined, [exampleModule]);
    const plan = {
      items: [
        { text: 'Find the documentation', status: 'in_progress' },
        { text: 'Answer with the link', status: 'pending' },
      ],
    };
    answers = [
      call('update_plan', plan),
      call('demo_list-things', {}),
      text('Done.'),
    ];
    const toolNames = () =>
      llm.requests
        .map(r => r.body)
        .filter(
          body =>
            !String(
              body.messages?.find(
                (message: { role?: string }) => message.role === 'system',
              )?.content,
            ).startsWith(TITLE_PROMPT_MARK),
        )
        .map(body =>
          (body.tools ?? []).map(
            (t: { function: { name: string } }) => t.function.name,
          ),
        );

    const created = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice)
      .send({ agentId: 'guide' })
      .expect(201);
    const base = `/api/ai-chat/sessions/${created.body.id}`;
    const res = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'how do I start?' })
      .expect(200);
    const message = await readMessage(await parseSse(res.text));

    const [first, second] = toolNames();
    expect(first).toEqual(['update_plan']);
    expect(second).toEqual(
      expect.arrayContaining(['demo_list-things', 'load_skill', 'update_plan']),
    );
    expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);
    expect(message.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'data-plan', data: plan }),
        expect.objectContaining({
          type: 'tool-update_plan',
          state: 'output-available',
          input: plan,
          output: 'Plan updated.',
        }),
      ]),
    );

    const tools = await request(server)
      .get(`${base}/tools`)
      .set('Authorization', alice)
      .expect(200);
    expect(tools.body.items.map((t: { id: string }) => t.id)).toContain(
      'update_plan',
    );

    // An agent without planning gets every tool in its first step.
    const plain = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice)
      .expect(201);
    answers = [text('Hi.')];
    const before = toolNames().length;
    await request(server)
      .post(`/api/ai-chat/sessions/${plain.body.id}/runs`)
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(200);
    expect(toolNames()[before]).toEqual(
      expect.arrayContaining(['demo_list-things', 'update_plan']),
    );
  });

  it('denies through the route', async () => {
    const server = await startBackend();
    answers = [call('demo_change-thing', { name: 'x' }), text('Not done.')];
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const base = `/api/ai-chat/sessions/${body.id}`;
    const first = await request(server)
      .post(`${base}/runs`)
      .set('Authorization', alice)
      .send({ text: 'change x' });
    const callId = (
      (await parseSse(first.text)).find(
        c => c.type === 'tool-approval-request',
      ) as any
    ).approvalId;
    const res = await request(server)
      .post(`${base}/tool-calls/${callId}/decision`)
      .set('Authorization', alice)
      .send({ approved: false })
      .expect(200);
    expect((await parseSse(res.text)).map(c => c.type)).toContain(
      'tool-output-denied',
    );
    expect(actions.invocations).toEqual([]);
  });

  it('shows the user a fixed text, not the answer of the model server, when the model fails', async () => {
    const server = await startBackend(() => ({
      status: 500,
      type: 'application/json',
      body: '{"error":"down: key sk-live-12345 rejected"}',
    }));
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', alice);
    const res = await request(server)
      .post(`/api/ai-chat/sessions/${body.id}/runs`)
      .set('Authorization', alice)
      .send({ text: 'hi' })
      .expect(200);
    const chunks = await parseSse(res.text);
    expect(chunks.map(c => c.type).slice(-2)).toEqual(['data-run', 'error']);
    expect(chunks[chunks.length - 1]).toEqual({
      type: 'error',
      errorText: 'The model call failed.',
    });
    expect(res.text).not.toContain('sk-live');
    expect(res.text).not.toContain('down');
  });

  async function startConfigured(options: {
    aiChat?: Record<string, unknown>;
    features?: Parameters<typeof startTestBackend>[0]['features'];
    logger?: ReturnType<typeof mockServices.logger.mock>;
  }) {
    const db = await createDb();
    const logger = options.logger ?? mockServices.logger.mock();
    try {
      const started = await startTestBackend({
        features: [
          aiChatPlugin,
          ...(options.features ?? []),
          mockServices.rootConfig.factory({
            data: {
              aiChat: {
                llm: { baseUrl: 'http://127.0.0.1:9', model: 'test-model' },
                ...options.aiChat,
              },
            },
          }),
          mockServices.database.factory({ knex: db }),
          mockServices.auditor.mock().factory,
          mockServices.httpAuth.factory({
            defaultCredentials: mockCredentials.none(),
          }),
          logger.factory,
          createServiceFactory({
            service: actionsServiceRef,
            deps: {},
            factory: () => new FakeActions([]),
          }),
        ],
      });
      return { server: started.server, logger, db };
    } catch (error) {
      await db.destroy();
      throw error;
    }
  }

  it('does not start when an agent in the configuration is not valid', async () => {
    await expect(
      startConfigured({
        aiChat: { agents: { 'bad id': { systemPrompt: 'x' } } },
      }),
    ).rejects.toThrow(/aiChat\.agents/);
  });

  it('does not start when a module registers the default agent', async () => {
    const clash = createBackendModule({
      pluginId: 'ai-chat',
      moduleId: 'clash',
      register(env) {
        env.registerInit({
          deps: { harness: aiChatHarnessExtensionPoint },
          async init({ harness }) {
            harness.addAgent({ id: 'default', systemPrompt: 'no' });
          },
        });
      },
    });
    await expect(startConfigured({ features: [clash] })).rejects.toThrow(
      /already defined/,
    );
  });

  it('does not start when a module registers the same agent twice', async () => {
    const twice = createBackendModule({
      pluginId: 'ai-chat',
      moduleId: 'twice',
      register(env) {
        env.registerInit({
          deps: { harness: aiChatHarnessExtensionPoint },
          async init({ harness }) {
            harness.addAgent({ id: 'guide', systemPrompt: 'once' });
            harness.addAgent({ id: 'guide', systemPrompt: 'twice' });
          },
        });
      },
    });
    await expect(startConfigured({ features: [twice] })).rejects.toThrow(
      /already registered/,
    );
  });

  it('serves an agent registered by a backend module', async () => {
    const logger = mockServices.logger.mock();
    const { server, db } = await startConfigured({
      features: [exampleModule],
      logger,
    });
    try {
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('1 agent(s)'),
      );
      const created = await request(server)
        .post('/api/ai-chat/sessions')
        .set('Authorization', alice)
        .send({ agentId: 'guide' })
        .expect(201);
      expect(created.body.agentId).toBe('guide');
    } finally {
      await db.destroy();
    }
  });

  it('does not start when a module registers an unknown hook', async () => {
    const badHook = createBackendModule({
      pluginId: 'ai-chat',
      moduleId: 'bad-hook',
      register(env) {
        env.registerInit({
          deps: { harness: aiChatHarnessExtensionPoint },
          async init({ harness }) {
            harness.addHook('nope' as never, (() => undefined) as never);
          },
        });
      },
    });
    await expect(startConfigured({ features: [badHook] })).rejects.toThrow(
      /unknown hook/,
    );
  });

  it('runs lifecycle hooks registered through aiChatHarnessExtensionPoint during HTTP runs', async () => {
    const events: string[] = [];
    let resolveOnRunEnd!: () => void;
    const onRunEndDone = new Promise<void>(resolve => {
      resolveOnRunEnd = resolve;
    });
    const hookModule = createBackendModule({
      pluginId: 'ai-chat',
      moduleId: 'hooks',
      register(env) {
        env.registerInit({
          deps: { harness: aiChatHarnessExtensionPoint },
          async init({ harness }) {
            harness.addHook('beforeModelCall', ctx => {
              events.push(`beforeModelCall:step=${ctx.step}`);
            });
            harness.addHook('beforeToolCall', toolCall => {
              events.push(`beforeToolCall:${toolCall.toolId}`);
              return { action: 'continue' };
            });
            harness.addHook('afterToolCall', (toolCall, result) => {
              events.push(`afterToolCall:${toolCall.toolId}`);
              return {
                ...result,
                output: { masked: true },
              };
            });
            harness.addHook('onRunEnd', summary => {
              events.push(`onRunEnd:${summary.status}`);
              resolveOnRunEnd();
            });
          },
        });
      },
    });

    answers = [
      call('demo_list-things', {}),
      text('Final reply after masked tool'),
    ];
    actions = new FakeActions([
      {
        id: 'demo:list-things',
        readOnly: true,
        run: () => ({ things: ['sensitive'] }),
      },
    ]);
    llm = await startLlmServer(body => {
      const system = body.messages?.find(
        (m: { role?: string }) => m.role === 'system',
      )?.content;
      if (typeof system === 'string' && system.startsWith(TITLE_PROMPT_MARK)) {
        return { body: text('Hooked title') };
      }
      const next = answers.shift() ?? text('done');
      return { body: next };
    });

    const logger = mockServices.logger.mock();
    const db = await createDb();
    try {
      const { server } = await startTestBackend({
        features: [
          aiChatPlugin,
          hookModule,
          mockServices.rootConfig.factory({
            data: {
              aiChat: { llm: { baseUrl: llm.url, model: 'test-model' } },
            },
          }),
          mockServices.database.factory({ knex: db }),
          mockServices.auditor.mock().factory,
          mockServices.httpAuth.factory({
            defaultCredentials: mockCredentials.none(),
          }),
          logger.factory,
          createServiceFactory({
            service: actionsServiceRef,
            deps: {},
            factory: () => actions,
          }),
        ],
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('4 hook(s)'),
      );
      const created = await request(server)
        .post('/api/ai-chat/sessions')
        .set('Authorization', alice)
        .send({})
        .expect(201);

      const runRes = await request(server)
        .post(`/api/ai-chat/sessions/${created.body.id}/runs`)
        .set('Authorization', alice)
        .send({ text: 'Run read tool', page: { path: '/ai-chat' } })
        .expect(200);

      await onRunEndDone;

      const uiMessage = await readMessage(await parseSse(runRes.text));
      expect(uiMessage.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-demo:list-things',
            state: 'output-available',
            output: { masked: true },
          }),
        ]),
      );
      expect(JSON.stringify(uiMessage)).not.toContain('sensitive');
      expect(events).toEqual([
        'beforeModelCall:step=1',
        'beforeToolCall:demo:list-things',
        'afterToolCall:demo:list-things',
        'beforeModelCall:step=2',
        'onRunEnd:completed',
      ]);
      // The title is written after the run ended; the database must outlive it.
      const deadline = Date.now() + 5000;
      for (;;) {
        const row = await db('sessions').where({ id: created.body.id }).first();
        if (row?.title === 'Hooked title') break;
        if (Date.now() > deadline) throw new Error('No title was written');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      await db.destroy();
    }
  });

  it('does not start when duplicate, malformed, or unknown agent skills are configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-chat-plugin-skills-bad-'));
    try {
      await mkdir(join(dir, 'dup-skill'));
      await writeFile(
        join(dir, 'dup-skill', 'SKILL.md'),
        '---\nname: dup-skill\ndescription: From dir\n---\nDir body',
      );
      const clashSkill = createBackendModule({
        pluginId: 'ai-chat',
        moduleId: 'clash-skill',
        register(env) {
          env.registerInit({
            deps: { harness: aiChatHarnessExtensionPoint },
            async init({ harness }) {
              harness.addSkill({
                id: 'dup-skill',
                description: 'From module',
                load: () => 'Module body',
              });
            },
          });
        },
      });
      await expect(
        startConfigured({
          features: [clashSkill],
          aiChat: { skills: { directories: [dir] } },
        }),
      ).rejects.toThrow(/already defined/);

      const twiceSkill = createBackendModule({
        pluginId: 'ai-chat',
        moduleId: 'twice-skill',
        register(env) {
          env.registerInit({
            deps: { harness: aiChatHarnessExtensionPoint },
            async init({ harness }) {
              harness.addSkill({
                id: 'dup',
                description: 'Once',
                load: () => 'One',
              });
              harness.addSkill({
                id: 'dup',
                description: 'Twice',
                load: () => 'Two',
              });
            },
          });
        },
      });
      await expect(startConfigured({ features: [twiceSkill] })).rejects.toThrow(
        /already registered/,
      );

      await expect(
        startConfigured({
          aiChat: {
            agents: { sre: { skills: ['missing-skill'] } },
          },
        }),
      ).rejects.toThrow(/unknown skill missing-skill/);

      const malformedDir = await mkdtemp(
        join(tmpdir(), 'ai-chat-plugin-skills-malformed-'),
      );
      try {
        await mkdir(join(malformedDir, 'broken'));
        await writeFile(join(malformedDir, 'broken', 'SKILL.md'), 'No FM');
        await expect(
          startConfigured({
            aiChat: { skills: { directories: [malformedDir] } },
          }),
        ).rejects.toThrow(/frontmatter/);
      } finally {
        await rm(malformedDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads SKILL.md directories and module skills, lists load_skill, and executes lazy loading over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-chat-plugin-skills-e2e-'));
    try {
      await mkdir(join(dir, 'deploy-failure'));
      await writeFile(
        join(dir, 'deploy-failure', 'SKILL.md'),
        [
          '---',
          'name: deploy-failure',
          'description: Diagnose failed deployments cleanly.',
          '---',
          '# Secret Deploy Checklist',
          '1. Inspect rollout status on example.com.',
        ].join('\n'),
      );

      const moduleSkillLoader = jest.fn(async () => 'Module skill details');
      const skillModule = createBackendModule({
        pluginId: 'ai-chat',
        moduleId: 'custom-skill',
        register(env) {
          env.registerInit({
            deps: { harness: aiChatHarnessExtensionPoint },
            async init({ harness }) {
              harness.addSkill({
                id: 'module-skill',
                description: 'Provided by backend module.',
                load: moduleSkillLoader,
              });
            },
          });
        },
      });

      answers = [
        call('load_skill', { id: 'deploy-failure' }),
        text('Used the deploy-failure checklist.'),
      ];
      let scripted = 0;
      llm = await startLlmServer(body => {
        const system = body.messages?.find(
          (m: { role?: string }) => m.role === 'system',
        )?.content;
        if (
          typeof system === 'string' &&
          system.startsWith(TITLE_PROMPT_MARK)
        ) {
          return { body: text('Skills E2E title') };
        }
        const index = scripted;
        scripted += 1;
        return { body: answers[Math.min(index, answers.length - 1)] };
      });

      const logger = mockServices.logger.mock();
      const { server } = await startTestBackend({
        features: [
          aiChatPlugin,
          skillModule,
          mockServices.rootConfig.factory({
            data: {
              aiChat: {
                llm: { baseUrl: llm.url, model: 'test-model' },
                skills: { directories: [dir] },
                agents: {
                  sre: {
                    title: 'SRE Agent',
                    skills: ['deploy-failure', 'module-skill'],
                  },
                },
              },
            },
          }),
          mockServices.database.factory({ knex: await createDb() }),
          mockServices.auditor.mock().factory,
          mockServices.httpAuth.factory({
            defaultCredentials: mockCredentials.none(),
          }),
          logger.factory,
          createServiceFactory({
            service: actionsServiceRef,
            deps: {},
            factory: () => new FakeActions([]),
          }),
        ],
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('2 skill(s)'),
      );

      const created = await request(server)
        .post('/api/ai-chat/sessions')
        .set('Authorization', alice)
        .send({ agentId: 'sre' })
        .expect(201);
      const sessionId = created.body.id;

      const toolsRes = await request(server)
        .get(`/api/ai-chat/sessions/${sessionId}/tools`)
        .set('Authorization', alice)
        .expect(200);
      expect(toolsRes.body.items.map((t: { id: string }) => t.id)).toContain(
        'load_skill',
      );

      const runRes = await request(server)
        .post(`/api/ai-chat/sessions/${sessionId}/runs`)
        .set('Authorization', alice)
        .send({ text: 'How do I debug deploy failure?' })
        .expect(200);

      const uiMessage = await readMessage(await parseSse(runRes.text));
      // Wait for post-run auto-title generation to finish before teardown.
      for (let i = 0; i < 40; i++) {
        const detail = await request(server)
          .get(`/api/ai-chat/sessions/${sessionId}`)
          .set('Authorization', alice)
          .expect(200);
        if (detail.body.session.title === 'Skills E2E title') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(uiMessage.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-load_skill',
            state: 'output-available',
            output: {
              id: 'deploy-failure',
              description: 'Diagnose failed deployments cleanly.',
              content:
                '# Secret Deploy Checklist\n1. Inspect rollout status on example.com.',
            },
          }),
        ]),
      );

      const chatRequests = llm.requests.filter(r => {
        const sys = (
          r.body as { messages?: { role?: string; content?: string }[] }
        ).messages?.[0]?.content;
        return typeof sys === 'string' && !sys.startsWith(TITLE_PROMPT_MARK);
      });
      expect(chatRequests).toHaveLength(2);
      const req1System = (
        chatRequests[0].body as { messages: { content: string }[] }
      ).messages[0].content;
      expect(req1System).toContain(
        '- deploy-failure: Diagnose failed deployments cleanly.',
      );
      expect(req1System).toContain(
        '- module-skill: Provided by backend module.',
      );
      expect(req1System).not.toContain('Secret Deploy Checklist');
      expect(moduleSkillLoader).not.toHaveBeenCalled();

      const req2Messages = (
        chatRequests[1].body as {
          messages: { role: string; content: string }[];
        }
      ).messages;
      expect(req2Messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            content: expect.stringContaining('Secret Deploy Checklist'),
          }),
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['without hooks', false],
    ['with an afterToolCall hook', true],
  ])(
    'cuts the text of a skill to maxToolOutputChars and says how much was cut (%s)',
    async (_name, withHook) => {
      const longSkill = createBackendModule({
        pluginId: 'ai-chat',
        moduleId: 'long-skill',
        register(env) {
          env.registerInit({
            deps: { harness: aiChatHarnessExtensionPoint },
            async init({ harness }) {
              harness.addSkill({
                id: 'long-skill',
                description: 'A very long procedure.',
                load: () => 'x'.repeat(500),
              });
              if (withHook) {
                harness.addHook('afterToolCall', (_call, result) => result);
              }
            },
          });
        },
      });
      answers = [call('load_skill', { id: 'long-skill' }), text('Done.')];
      let scripted = 0;
      llm = await startLlmServer(body => {
        const system = body.messages?.find(
          (m: { role?: string }) => m.role === 'system',
        )?.content;
        if (
          typeof system === 'string' &&
          system.startsWith(TITLE_PROMPT_MARK)
        ) {
          return { body: text('Long skill title') };
        }
        const index = scripted;
        scripted += 1;
        return { body: answers[Math.min(index, answers.length - 1)] };
      });
      const db = await createDb();
      try {
        const { server } = await startTestBackend({
          features: [
            aiChatPlugin,
            longSkill,
            mockServices.rootConfig.factory({
              data: {
                aiChat: {
                  llm: { baseUrl: llm.url, model: 'test-model' },
                  maxToolOutputChars: 200,
                },
              },
            }),
            mockServices.database.factory({ knex: db }),
            mockServices.auditor.mock().factory,
            mockServices.httpAuth.factory({
              defaultCredentials: mockCredentials.none(),
            }),
            createServiceFactory({
              service: actionsServiceRef,
              deps: {},
              factory: () => new FakeActions([]),
            }),
          ],
        });
        const created = await request(server)
          .post('/api/ai-chat/sessions')
          .set('Authorization', alice)
          .send({})
          .expect(201);
        const runRes = await request(server)
          .post(`/api/ai-chat/sessions/${created.body.id}/runs`)
          .set('Authorization', alice)
          .send({ text: 'Load the long skill' })
          .expect(200);

        const uiMessage = await readMessage(await parseSse(runRes.text));
        const part = uiMessage.parts.find(
          (p: { type: string }) => p.type === 'tool-load_skill',
        ) as { output: Record<string, unknown> } | undefined;
        expect(Object.keys(part?.output ?? {}).sort()).toEqual([
          'content',
          'description',
          'id',
        ]);
        expect(part?.output).toMatchObject({
          id: 'long-skill',
          description: 'A very long procedure.',
        });
        expect(JSON.stringify(part?.output).length).toBeLessThanOrEqual(200);
        const content = String(part?.output.content);
        const kept = content.indexOf('\n');
        expect(content).toBe(
          `${'x'.repeat(kept)}\n\n[Skill cut: ${
            500 - kept
          } of 500 characters left out.]`,
        );
        // The title is written after the run ended; the database must outlive it.
        const deadline = Date.now() + 5000;
        for (;;) {
          const row = await db('sessions')
            .where({ id: created.body.id })
            .first();
          if (row?.title === 'Long skill title') break;
          if (Date.now() > deadline) throw new Error('No title was written');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally {
        await db.destroy();
      }
    },
  );
});

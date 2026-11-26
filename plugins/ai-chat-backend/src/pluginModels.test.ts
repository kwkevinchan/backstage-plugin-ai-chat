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
import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import {
  aiChatHarnessExtensionPoint,
  type ModelClient,
  type ModelInput,
} from '@kwkevinchan/backstage-plugin-ai-chat-node';
import type { JsonObject } from '@backstage/types';
import request from 'supertest';
import { TITLE_PROMPT_MARK } from './application';
import { parseSse } from './adapters/http/__testUtils__/uiMessageStream';
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

const alice = mockCredentials.user.header('user:default/alice');
const bob = mockCredentials.user.header('user:default/bob');

/** A model server that answers every call, titles included, with `answer`. */
function answering(answer: () => string) {
  return (body: any) => {
    const system = body.messages?.find((m: any) => m.role === 'system');
    return String(system?.content).startsWith(TITLE_PROMPT_MARK)
      ? { body: text('A title') }
      : { body: answer() };
  };
}

/** A module that adds the model client `echo` and the agent `helper` on it. */
function echoModule(seen: ModelInput[]) {
  const client: ModelClient = {
    capabilities: { parallelToolCalls: false, images: false },
    async *stream(input) {
      seen.push(input);
      yield { type: 'text', text: 'from echo' };
    },
  };
  return createBackendModule({
    pluginId: 'ai-chat',
    moduleId: 'echo',
    register(env) {
      env.registerInit({
        deps: { harness: aiChatHarnessExtensionPoint },
        async init({ harness }) {
          harness.addModelClient('echo', client);
          harness.addAgent({
            id: 'helper',
            systemPrompt: 'You help.',
            model: 'echo',
          });
        },
      });
    },
  });
}

describe('aiChatPlugin: models and limits (P3-07)', () => {
  const servers: LlmServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  async function start(options: {
    aiChat: JsonObject;
    features?: Parameters<typeof startTestBackend>[0]['features'];
  }) {
    const db = await createDb();
    try {
      const started = await startTestBackend({
        features: [
          aiChatPlugin,
          ...(options.features ?? []),
          mockServices.rootConfig.factory({
            data: { aiChat: options.aiChat },
          }),
          mockServices.database.factory({ knex: db }),
          mockServices.auditor.mock().factory,
          mockServices.httpAuth.factory({
            defaultCredentials: mockCredentials.none(),
          }),
          createServiceFactory({
            service: actionsServiceRef,
            deps: {},
            factory: () =>
              new FakeActions([
                {
                  id: 'demo:list-things',
                  readOnly: true,
                  run: () => ({ things: [1] }),
                },
                { id: 'demo:change-thing', destructive: true },
              ]),
          }),
        ],
      });
      return { server: started.server, db };
    } catch (error) {
      await db.destroy();
      throw error;
    }
  }

  async function llmServer(answer: () => string) {
    const server = await startLlmServer(answering(answer));
    servers.push(server);
    return server;
  }

  async function send(server: any, agentId: string | undefined, user = alice) {
    const { body } = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', user)
      .send(agentId ? { agentId } : {})
      .expect(201);
    return request(server)
      .post(`/api/ai-chat/sessions/${body.id}/runs`)
      .set('Authorization', user)
      .send({ text: 'hi' });
  }

  it('sends the run of an agent to the model it names: a model of aiChat.models, a client of a module, or default', async () => {
    const main = await llmServer(() => text('from default'));
    const small = await llmServer(() => text('from small'));
    const seen: ModelInput[] = [];
    const { server, db } = await start({
      aiChat: {
        llm: { baseUrl: main.url, model: 'main-model' },
        models: {
          small: {
            baseUrl: small.url,
            model: 'small-model',
            parallelToolCalls: true,
          },
        },
        agents: { sre: { systemPrompt: 'You help.', model: 'small' } },
      },
      features: [echoModule(seen)],
    });
    try {
      const sre = await send(server, 'sre');
      expect(sre.status).toBe(200);
      expect(sre.text).toContain('from small');
      const fromSmall = small.requests.filter(
        r => !String(r.body.messages[0].content).startsWith(TITLE_PROMPT_MARK),
      );
      expect(fromSmall[0].body).toMatchObject({
        model: 'small-model',
        parallel_tool_calls: true,
      });

      const helper = await send(server, 'helper');
      expect(helper.text).toContain('from echo');
      expect(seen.length).toBeGreaterThanOrEqual(1);

      const plain = await send(server, undefined);
      expect(plain.text).toContain('from default');
      const fromMain = main.requests.filter(
        r => !String(r.body.messages[0].content).startsWith(TITLE_PROMPT_MARK),
      );
      expect(fromMain).toHaveLength(1);
      expect(fromMain[0].body.model).toBe('main-model');
      expect(fromMain[0].body.parallel_tool_calls).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it('does not start when a module adds a model client with an id of the configuration', async () => {
    const llm = { baseUrl: 'http://127.0.0.1:9', model: 'm' };
    const clash = (id: string) =>
      createBackendModule({
        pluginId: 'ai-chat',
        moduleId: `clash-${id}`,
        register(env) {
          env.registerInit({
            deps: { harness: aiChatHarnessExtensionPoint },
            async init({ harness }) {
              harness.addModelClient(id, {
                capabilities: { parallelToolCalls: false, images: false },
                async *stream() {},
              });
            },
          });
        },
      });
    await expect(
      start({ aiChat: { llm }, features: [clash('default')] }),
    ).rejects.toThrow(
      'model client default is already defined in the configuration',
    );
    await expect(
      start({
        aiChat: { llm, models: { small: llm } },
        features: [clash('small')],
      }),
    ).rejects.toThrow(
      'model client small is already defined in the configuration',
    );
  });

  it('does not start when an agent names a model that does not exist', async () => {
    await expect(
      start({
        aiChat: {
          llm: { baseUrl: 'http://127.0.0.1:9', model: 'm' },
          agents: { sre: { systemPrompt: 'x', model: 'missing' } },
        },
      }),
    ).rejects.toThrow('aiChat.agents.sre.model: unknown model missing');
  });

  it('answers 429 TooManyActiveRuns beyond runsPerUser, for that user only', async () => {
    const llm = await llmServer(() => call('demo_change-thing', { name: 'x' }));
    const { server, db } = await start({
      aiChat: { llm: { baseUrl: llm.url, model: 'm' }, runsPerUser: 1 },
    });
    try {
      const first = await send(server, undefined);
      const chunks = await parseSse(first.text);
      expect(chunks.some(c => c.type === 'tool-approval-request')).toBe(true);

      const second = await send(server, undefined);
      expect(second.status).toBe(429);
      expect(second.body.error).toMatchObject({ name: 'TooManyActiveRuns' });

      const other = await send(server, undefined, bob);
      expect(other.status).toBe(200);
    } finally {
      await db.destroy();
    }
  });
});

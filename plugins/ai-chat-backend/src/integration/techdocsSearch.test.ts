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

import { Readable, Writable } from 'node:stream';
import {
  createBackendModule,
  type BackstageCredentials,
} from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { catalogEntityReadPermission } from '@backstage/plugin-catalog-common/alpha';
import {
  AuthorizeResult,
  type PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  searchEngineRegistryExtensionPoint,
  searchIndexRegistryExtensionPoint,
} from '@backstage/plugin-search-backend-node/alpha';
import type {
  IndexableResult,
  IndexableResultSet,
  QueryRequestOptions,
  SearchEngine,
  SearchQuery,
} from '@backstage/plugin-search-common';
import searchPlugin from '@backstage/plugin-search-backend';
import request from 'supertest';
import {
  parseSse,
  readMessage,
} from '../adapters/http/__testUtils__/uiMessageStream';
import { TITLE_PROMPT_MARK } from '../application';
import {
  createDb,
  startLlmServer,
  sseBody,
  type LlmServer,
} from '../__testUtils__';
import { aiChatPlugin } from '../plugin';

// X-08: the chat searches TechDocs through the official `search:query` action
// of the search backend, as the user who sent the message. The search backend,
// the actions registry, the actions service and the permission filter of the
// search backend are the real ones; the search engine and the permission
// policy are fakes.

const ALICE = 'user:default/alice';
const BOB = 'user:default/bob';
const INTERNAL_ADDRESS = 'http://search-engine.internal:9200';

/** The entities whose documents each user may read (`catalog.entity.read`). */
const READABLE: Record<string, string[]> = {
  [ALICE]: ['component:default/payments'],
  [BOB]: ['component:default/billing'],
};

function techdocs(entity: string, page: string, text: string): IndexableResult {
  return {
    type: 'techdocs',
    document: {
      title: `${entity} ${page}`,
      text,
      location: `/docs/default/component/${entity}/${page}/`,
      authorization: { resourceRef: `component:default/${entity}` },
    },
  };
}

const DOCS = [
  techdocs('payments', 'deploy', 'How to deploy the payments service.'),
  techdocs('billing', 'deploy', 'How to deploy the billing service.'),
];

class FakeSearchEngine implements SearchEngine {
  readonly queries: {
    query: SearchQuery;
    credentials?: BackstageCredentials;
  }[] = [];
  docs: IndexableResult[] = DOCS;
  /** Replaces the answer of `query`, for errors and calls that never end. */
  answer?: () => Promise<IndexableResultSet>;

  setTranslator() {}

  async getIndexer() {
    return new Writable({
      objectMode: true,
      write: (_chunk, _encoding, done) => done(),
    });
  }

  async query(
    query: SearchQuery,
    options?: QueryRequestOptions,
  ): Promise<IndexableResultSet> {
    // The type still names a token; the search backend passes the credentials
    // of the caller.
    const { credentials } = (options ?? {}) as {
      credentials?: BackstageCredentials;
    };
    this.queries.push({ query, credentials });
    if (this.answer) return this.answer();
    const term = query.term.toLowerCase();
    return {
      results: this.docs.filter(
        result =>
          (!query.types || query.types.includes(result.type)) &&
          `${result.document.title} ${result.document.text}`
            .toLowerCase()
            .includes(term),
      ),
    };
  }
}

function userOf(credentials: BackstageCredentials): string | undefined {
  const principal = credentials.principal as { userEntityRef?: string };
  return principal.userEntityRef;
}

/**
 * A permission policy: a user reads the entities in `READABLE`, through a
 * conditional decision as the catalog gives it; everything else is allowed.
 */
function permissionPolicy() {
  return mockServices.permissions.mock({
    authorizeConditional: async requests =>
      requests.map(
        ({ permission }): PolicyDecision =>
          permission.name === catalogEntityReadPermission.name
            ? {
                result: AuthorizeResult.CONDITIONAL,
                pluginId: 'catalog',
                resourceType: 'catalog-entity',
                conditions: {
                  rule: 'IS_READABLE',
                  resourceType: 'catalog-entity',
                  params: {},
                },
              }
            : { result: AuthorizeResult.ALLOW },
      ) as any,
    authorize: async (requests, options) =>
      requests.map(req => {
        const resourceRef = (req as { resourceRef?: string }).resourceRef;
        if (req.permission.name !== catalogEntityReadPermission.name) {
          return { result: AuthorizeResult.ALLOW };
        }
        const user = userOf(options.credentials);
        return {
          result:
            user && resourceRef && READABLE[user]?.includes(resourceRef)
              ? AuthorizeResult.ALLOW
              : AuthorizeResult.DENY,
        };
      }),
  });
}

/** Gives the search backend the fake engine and the type `techdocs`. */
function searchModule(engine: FakeSearchEngine) {
  return createBackendModule({
    pluginId: 'search',
    moduleId: 'test-techdocs',
    register(env) {
      env.registerInit({
        deps: {
          engines: searchEngineRegistryExtensionPoint,
          indexes: searchIndexRegistryExtensionPoint,
        },
        async init({ engines, indexes }) {
          engines.setSearchEngine(engine);
          indexes.addCollator({
            // The documents are in the fake engine; the collator only gives
            // the type and its permission, as the TechDocs collator does.
            schedule: { run: async () => {} },
            factory: {
              type: 'techdocs',
              visibilityPermission: catalogEntityReadPermission,
              getCollator: async () => Readable.from([]),
            },
          });
        },
      });
    },
  });
}

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

/** The tool messages of every request to the model server, in order. */
function toolMessages(llm: LlmServer): string[] {
  return llm.requests.flatMap(({ body }) =>
    (body.messages ?? [])
      .filter((m: { role?: string }) => m.role === 'tool')
      .map((m: { content: string }) => m.content),
  );
}

describe('TechDocs search through the search:query action (X-08)', () => {
  let llm: LlmServer | undefined;
  let engine: FakeSearchEngine;
  let release: (() => void) | undefined;

  afterEach(async () => {
    release?.();
    release = undefined;
    await llm?.close();
    llm = undefined;
  });

  /**
   * A backend with the chat and the search backend. Each conversation of the
   * model server calls `search:query` with `input`, then answers with text.
   */
  async function start(
    options: {
      input?: unknown;
      aiChat?: Record<string, unknown>;
    } = {},
  ) {
    engine = new FakeSearchEngine();
    llm = await startLlmServer(body => {
      const messages: { role?: string; content?: unknown }[] =
        body.messages ?? [];
      const system = messages.find(m => m.role === 'system')?.content;
      if (typeof system === 'string' && system.startsWith(TITLE_PROMPT_MARK)) {
        return { body: text('Search') };
      }
      if (messages.some(m => m.role === 'tool')) {
        return { body: text('Here is what the docs say.') };
      }
      return {
        body: call(
          'search_query',
          options.input ?? { term: 'deploy', types: ['techdocs'] },
        ),
      };
    });
    const db = await createDb();
    const { server } = await startTestBackend({
      features: [
        aiChatPlugin,
        searchPlugin,
        searchModule(engine),
        mockServices.rootConfig.factory({
          data: {
            backend: { actions: { pluginSources: ['search'] } },
            permission: { enabled: true },
            aiChat: {
              llm: { baseUrl: llm.url, model: 'test-model' },
              toolsets: { docs: { actions: ['search:query'], default: true } },
              ...options.aiChat,
            },
          },
        }),
        mockServices.database.factory({ knex: db }),
        mockServices.auditor.mock().factory,
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        permissionPolicy().factory,
      ],
    });
    return server;
  }

  async function ask(
    server: Awaited<ReturnType<typeof start>>,
    user: string,
    message = 'How do I deploy?',
  ) {
    const auth = mockCredentials.user.header(user);
    const session = await request(server)
      .post('/api/ai-chat/sessions')
      .set('Authorization', auth)
      .send({})
      .expect(201);
    const run = await request(server)
      .post(`/api/ai-chat/sessions/${session.body.id}/runs`)
      .set('Authorization', auth)
      .send({ text: message })
      .expect(200);
    return { sessionId: session.body.id as string, auth, stream: run.text };
  }

  async function searchPart(stream: string) {
    const message = await readMessage(await parseSse(stream));
    return message.parts.find(
      (part: { type: string }) => part.type === 'tool-search:query',
    ) as any;
  }

  it('offers search:query as a read-only tool and runs it without approval', async () => {
    const server = await start();
    const { sessionId, auth, stream } = await ask(server, ALICE);

    const tools = await request(server)
      .get(`/api/ai-chat/sessions/${sessionId}/tools`)
      .set('Authorization', auth)
      .expect(200);
    expect(tools.body.items).toEqual([
      expect.objectContaining({ id: 'search:query', readOnly: true }),
    ]);

    const part = await searchPart(stream);
    expect(part).toMatchObject({
      state: 'output-available',
      input: { term: 'deploy', types: ['techdocs'] },
    });
    expect(stream).not.toContain('tool-approval-request');
    expect(engine.queries).toHaveLength(1);
  });

  it('searches as the user who asks, and returns only the documents that user may read', async () => {
    const server = await start();

    const alice = await ask(server, ALICE);
    const bob = await ask(server, BOB);

    // The search engine is called with the credentials of each user, not with
    // a service identity.
    expect(engine.queries.map(q => q.credentials?.principal)).toEqual([
      expect.objectContaining({ type: 'user', userEntityRef: ALICE }),
      expect.objectContaining({ type: 'user', userEntityRef: BOB }),
    ]);

    const aliceOutput = (await searchPart(alice.stream)).output;
    expect(aliceOutput.results.map((r: any) => r.document.location)).toEqual([
      '/docs/default/component/payments/deploy/',
    ]);
    const bobOutput = (await searchPart(bob.stream)).output;
    expect(bobOutput.results.map((r: any) => r.document.location)).toEqual([
      '/docs/default/component/billing/deploy/',
    ]);

    // What the model reads next is only what the user may read.
    const [aliceTool, bobTool] = toolMessages(llm!);
    expect(aliceTool).toContain('payments service');
    expect(aliceTool).not.toContain('billing');
    expect(bobTool).toContain('billing service');
    expect(bobTool).not.toContain('payments');
    // The search backend takes the permission data out of the results.
    expect(aliceTool).not.toContain('resourceRef');
  });

  it('gives the model the title and the link of every result, to cite', async () => {
    const server = await start();
    engine.docs = [
      techdocs('payments', 'deploy', 'Deploy with the pipeline.'),
      techdocs('payments', 'rollback', 'Roll back a deploy.'),
    ];

    await ask(server, ALICE);

    const [tool] = toolMessages(llm!);
    expect(tool).toContain('/docs/default/component/payments/deploy/');
    expect(tool).toContain('/docs/default/component/payments/rollback/');
    expect(tool).toContain('payments deploy');
    expect(tool).toContain('payments rollback');
  });

  it('turns an error of the search engine into a fixed message without its internal address', async () => {
    const server = await start();
    engine.answer = async () => {
      throw new Error(`connect ECONNREFUSED ${INTERNAL_ADDRESS}`);
    };

    const { stream } = await ask(server, ALICE);

    const part = await searchPart(stream);
    expect(part).toMatchObject({
      state: 'output-error',
      errorText: 'Request failed with 500 Internal Server Error',
    });
    const [tool] = toolMessages(llm!);
    expect(tool).toContain('Request failed with 500 Internal Server Error');
    expect(tool).not.toContain('search-engine.internal');
    expect(stream).not.toContain('search-engine.internal');
    expect(JSON.stringify(llm!.requests)).not.toContain(
      'search-engine.internal',
    );
    // The run goes on: the model answers after the failed call.
    expect(stream).toContain('Here is what the docs say.');
  });

  it('ends the run at runTimeoutSeconds when the search does not answer', async () => {
    const server = await start({ aiChat: { runTimeoutSeconds: 1 } });
    engine.answer = () =>
      new Promise(resolve => {
        release = () => resolve({ results: [] });
      });

    const { sessionId, auth, stream } = await ask(server, ALICE);

    const chunks = await parseSse(stream);
    const runStates = chunks.filter(c => c.type === 'data-run');
    expect(runStates[runStates.length - 1]).toMatchObject({
      data: { status: 'completed', endReason: 'timeout' },
    });
    expect(stream).not.toContain('Here is what the docs say.');
    const session = await request(server)
      .get(`/api/ai-chat/sessions/${sessionId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(session.body.items.map((item: any) => item.kind)).toEqual([
      'user_message',
      'tool_call',
    ]);
    expect(engine.queries).toHaveLength(1);
  }, 15_000);

  it('cuts a long output to aiChat.maxToolOutputChars', async () => {
    const server = await start({ aiChat: { maxToolOutputChars: 300 } });
    engine.docs = [
      techdocs('payments', 'deploy', `Deploy. ${'x'.repeat(2000)}`),
    ];

    const { stream } = await ask(server, ALICE);

    const [tool] = toolMessages(llm!);
    expect(tool).toContain('originalLength');
    expect(tool).not.toContain('x'.repeat(400));
    const part = await searchPart(stream);
    expect(JSON.stringify(part.output).length).toBeLessThanOrEqual(300);
    expect(part.output).toEqual({
      text: expect.any(String),
      originalLength: expect.any(Number),
    });
  });

  it.each([
    [
      'without a term',
      { types: ['techdocs'] },
      "input must have required property 'term'",
    ],
    ['with a term that is not text', { term: 42 }, 'input/term must be string'],
    [
      'with a type that does not exist',
      { term: 'deploy', types: ['nope'] },
      'input/types/0 must be equal to one of the allowed values',
    ],
  ])(
    'does not run the action for an input %s',
    async (_name, input, message) => {
      const server = await start({ input });

      const { sessionId, auth, stream } = await ask(server, ALICE);

      expect(engine.queries).toHaveLength(0);
      const part = await searchPart(stream);
      expect(part?.state).toBe('output-error');
      const session = await request(server)
        .get(`/api/ai-chat/sessions/${sessionId}`)
        .set('Authorization', auth)
        .expect(200);
      // The chat checks the input against the schema of the action and stores
      // `invalid`; the action registry is never asked (it would answer 400).
      expect(
        session.body.items.filter((item: any) => item.kind === 'tool_result'),
      ).toEqual([expect.objectContaining({ status: 'invalid', message })]);
      expect(part.errorText).toBe(message);
      expect(stream).toContain('Here is what the docs say.');
    },
  );

  it('keeps the permission filter for an empty term, which the action accepts', async () => {
    const server = await start({ input: { term: '', types: ['techdocs'] } });

    const { stream } = await ask(server, BOB);

    expect(engine.queries).toHaveLength(1);
    const output = (await searchPart(stream)).output;
    expect(output.results.map((r: any) => r.document.location)).toEqual([
      '/docs/default/component/billing/deploy/',
    ]);
  });
});

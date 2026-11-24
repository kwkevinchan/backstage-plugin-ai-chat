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

import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resolvePackagePath,
  type BackstageCredentials,
} from '@backstage/backend-plugin-api';
import type {
  ActionsService,
  ActionsServiceAction,
} from '@backstage/backend-plugin-api/alpha';
import { mockCredentials, TestDatabases } from '@backstage/backend-test-utils';
import type { JsonObject, JsonValue } from '@backstage/types';
import type { Request } from 'express';
import type { Knex } from 'knex';
import type { ChatCaller, ChatStream } from '../chat/ChatService';
import type { ChatEvent } from '../common';
import type {
  LlmClient,
  LlmRequest,
  LlmResult,
} from '../llm/OpenAiCompatibleClient';

/**
 * The database of the tests: SQLite, or PostgreSQL 16 when its connection
 * string is in the environment (CI starts a PostgreSQL service and sets it;
 * see CONTRIBUTING.md). No container is started on its own.
 */
const POSTGRES_URL_VARIABLE =
  'BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING';
const databaseId = process.env[POSTGRES_URL_VARIABLE]
  ? 'POSTGRES_16'
  : 'SQLITE_3';
const databases = TestDatabases.create({ ids: [databaseId] });

/** An empty database of the kind that the tests run on. */
export function createDb(): Promise<Knex> {
  return databases.init(databaseId);
}

/** A migrated database. */
export async function createMigratedDb(): Promise<Knex> {
  const db = await createDb();
  await db.migrate.latest({
    directory: resolvePackagePath(
      '@kwkevinchan/backstage-plugin-ai-chat-backend',
      'migrations',
    ),
  });
  return db;
}

/** A definition of a fake action. */
export interface FakeActionOptions {
  id: string;
  title?: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
  secrets?: boolean;
  /** What the action returns; a function can also throw. */
  run?: (input: JsonObject) => JsonValue | Promise<JsonValue>;
}

/** The actions service with a list of actions, that records every invocation. */
export class FakeActions implements ActionsService {
  readonly invocations: Array<{
    id: string;
    input?: JsonObject;
    credentials: BackstageCredentials;
  }> = [];

  constructor(private actions: FakeActionOptions[]) {}

  setActions(actions: FakeActionOptions[]) {
    this.actions = actions;
  }

  async list(): Promise<{ actions: ActionsServiceAction[] }> {
    return {
      actions: this.actions.map(a => ({
        id: a.id,
        pluginId: a.id.split(':')[0],
        name: a.id.split(':')[1] ?? a.id,
        title: a.title ?? a.id,
        description: a.description ?? `The action ${a.id}`,
        schema: {
          input: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          output: { type: 'object' },
          ...(a.secrets ? { secrets: { type: 'object' } } : {}),
        },
        attributes: {
          readOnly: a.readOnly ?? false,
          destructive: a.destructive ?? !(a.readOnly ?? false),
          idempotent: a.readOnly ?? false,
        },
      })),
    };
  }

  async invoke(opts: {
    id: string;
    input?: JsonObject;
    credentials: BackstageCredentials;
  }): Promise<{ output: JsonValue }> {
    this.invocations.push(opts);
    const action = this.actions.find(a => a.id === opts.id);
    if (!action) throw new Error(`Action ${opts.id} not found`);
    const output = await (action.run?.(opts.input ?? {}) ?? { ok: true });
    return { output };
  }
}

/** One scripted answer of the model: text, or the calls it asks for. */
export type ScriptedAnswer =
  | string
  | {
      text?: string;
      calls: Array<{ id?: string; name: string; args: unknown }>;
    }
  | ((request: LlmRequest) => LlmResult);

/** A model that gives the scripted answers in order and records its requests. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly answers: ScriptedAnswer[]) {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(
      JSON.parse(JSON.stringify({ ...request, signal: undefined })),
    );
    const answer = this.answers[Math.min(this.index, this.answers.length - 1)];
    this.index += 1;
    return toResult(answer, request);
  }
}

function toResult(answer: ScriptedAnswer, request: LlmRequest): LlmResult {
  if (typeof answer === 'function') return answer(request);
  const result: LlmResult =
    typeof answer === 'string'
      ? { content: answer, toolCalls: [] }
      : {
          content: answer.text ?? '',
          toolCalls: answer.calls.map((call, i) => ({
            id: call.id ?? `call_${i + 1}`,
            name: call.name,
            arguments:
              typeof call.args === 'string'
                ? call.args
                : JSON.stringify(call.args),
          })),
        };
  if (result.content) request.onText?.(result.content);
  return result;
}

/** Collects the events of a response. */
export function recordStream(signal?: AbortSignal): ChatStream & {
  events: ChatEvent[];
} {
  const events: ChatEvent[] = [];
  return {
    events,
    emit: event => events.push(event),
    signal: signal ?? new AbortController().signal,
  };
}

export function caller(
  userEntityRef = 'user:default/alice',
  request: Partial<Request> = {},
): ChatCaller {
  return {
    credentials: mockCredentials.user(userEntityRef),
    userEntityRef,
    request: request as Request,
  };
}

/** A local server that gives the answers of a model server. */
export interface LlmServer {
  url: string;
  requests: Array<{ headers: IncomingMessage['headers']; body: any }>;
  close(): Promise<void>;
}

export async function startLlmServer(
  respond: (
    body: any,
    index: number,
  ) => { status?: number; type?: string; body: string },
): Promise<LlmServer> {
  const requests: LlmServer['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}');
    requests.push({ headers: req.headers, body });
    const answer = respond(body, requests.length - 1);
    res.writeHead(answer.status ?? 200, {
      'Content-Type': answer.type ?? 'text/event-stream',
    });
    res.end(answer.body);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(r => server.close(() => r())),
  };
}

/** The body of a streamed answer of a model server. */
export function sseBody(chunks: unknown[]): string {
  return `${chunks
    .map(c => `data: ${JSON.stringify(c)}\n\n`)
    .join('')}data: [DONE]\n\n`;
}

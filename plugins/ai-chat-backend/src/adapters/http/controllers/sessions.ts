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

import type {
  ChatSession,
  ChatSessionDetail,
  ChatSessionList,
  ChatToolList,
  ChatToolsetList,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  CreateSession,
  DeleteSession,
  GetSession,
  ListSessionTools,
  ListSessions,
  ListToolsets,
  UpdateSession,
} from '../../../application';
import type { Principal } from '../../../domain';
import {
  toChatSession,
  toChatSessionDetail,
  toChatToolset,
} from '../presenters/session';
import {
  afterSeqQuery,
  createSessionBody,
  listQuery,
  parse,
  updateSessionBody,
} from '../requestSchemas';

export type SessionUseCases = {
  createSession: Pick<CreateSession, 'execute'>;
  getSession: Pick<GetSession, 'execute'>;
  listSessions: Pick<ListSessions, 'execute'>;
  updateSession: Pick<UpdateSession, 'execute'>;
  deleteSession: Pick<DeleteSession, 'execute'>;
  listToolsets: Pick<ListToolsets, 'execute'>;
  listSessionTools: Pick<ListSessionTools, 'execute'>;
};

/**
 * The JSON routes of the sessions: each one turns the request into the input
 * of a use case and the result into the types of the API.
 */
export class SessionsController {
  constructor(private readonly useCases: SessionUseCases) {}

  async list(principal: Principal, query: unknown): Promise<ChatSessionList> {
    const { includeArchived, limit, q } = parse(listQuery, query);
    const sessions = await this.useCases.listSessions.execute({
      principal,
      ...(includeArchived !== undefined && {
        includeArchived: includeArchived === 'true',
      }),
      ...(limit !== undefined && { limit }),
      ...(q && { query: q }),
    });
    return { items: sessions.map(toChatSession) };
  }

  async create(principal: Principal, body: unknown): Promise<ChatSession> {
    const session = await this.useCases.createSession.execute({
      principal,
      ...parse(createSessionBody, body),
    });
    return toChatSession(session);
  }

  async get(
    principal: Principal,
    sessionId: string,
    query: unknown,
  ): Promise<ChatSessionDetail> {
    const { afterSeq } = parse(afterSeqQuery, query);
    return toChatSessionDetail(
      await this.useCases.getSession.execute({
        principal,
        sessionId,
        ...(afterSeq !== undefined && { afterSeq }),
      }),
    );
  }

  async update(
    principal: Principal,
    sessionId: string,
    body: unknown,
  ): Promise<ChatSession> {
    const session = await this.useCases.updateSession.execute({
      principal,
      sessionId,
      patch: parse(updateSessionBody, body),
    });
    return toChatSession(session);
  }

  async delete(principal: Principal, sessionId: string): Promise<void> {
    await this.useCases.deleteSession.execute({ principal, sessionId });
  }

  async tools(principal: Principal, sessionId: string): Promise<ChatToolList> {
    return {
      items: await this.useCases.listSessionTools.execute({
        principal,
        sessionId,
      }),
    };
  }

  async toolsets(): Promise<ChatToolsetList> {
    return {
      items: (await this.useCases.listToolsets.execute()).map(toChatToolset),
    };
  }
}

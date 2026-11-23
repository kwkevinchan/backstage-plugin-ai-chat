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

import { randomUUID } from 'node:crypto';
import { Knex } from 'knex';
import type { JsonObject, JsonValue } from '@backstage/types';
import type {
  ChatActionAttributes,
  ChatConversation,
  ChatMessage,
  ChatRole,
  ChatToolCallStatus,
} from '../common';

/** A message as stored, with the role `tool` that the API does not show. */
export interface StoredMessage {
  id: string;
  seq: number;
  role: ChatRole | 'tool';
  content: string;
  /** For the role `tool`: the call ID that the model gave. */
  llmCallId?: string;
  createdAt: string;
}

export interface StoredToolCall {
  id: string;
  conversationId: string;
  messageId: string;
  position: number;
  llmCallId: string;
  toolName: string;
  actionId: string;
  title: string;
  description: string;
  input: JsonObject;
  attributes: ChatActionAttributes;
  status: ChatToolCallStatus;
  output?: JsonValue;
  error?: string;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewToolCall {
  messageId: string;
  position: number;
  llmCallId: string;
  toolName: string;
  actionId: string;
  title: string;
  description: string;
  input: JsonObject;
  attributes: ChatActionAttributes;
  status: ChatToolCallStatus;
  error?: string;
}

/** The states in which a call still has no result. */
export const UNRESOLVED_STATUSES: ChatToolCallStatus[] = [
  'pending_approval',
  'approved',
  'running',
];

const now = () => new Date().toISOString();

function toMessage(row: any): StoredMessage {
  return {
    id: row.id,
    seq: Number(row.seq),
    role: row.role,
    content: row.content,
    llmCallId: row.tool_call_id ?? undefined,
    createdAt: row.created_at,
  };
}

function toToolCall(row: any): StoredToolCall {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    position: Number(row.position),
    llmCallId: row.llm_call_id,
    toolName: row.tool_name,
    actionId: row.action_id,
    title: row.action_title,
    description: row.action_description,
    input: JSON.parse(row.input),
    attributes: JSON.parse(row.attributes),
    status: row.status,
    output: row.output === null ? undefined : JSON.parse(row.output),
    error: row.error ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConversation(row: any): ChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toApiMessage(message: StoredMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role as ChatRole,
    content: message.content,
    createdAt: message.createdAt,
  };
}

/** The tables of the plugin. Every method that takes a user ref is owner-only. */
export class ChatStore {
  constructor(private readonly db: Knex) {}

  async createConversation(
    userEntityRef: string,
    title: string,
  ): Promise<ChatConversation> {
    const at = now();
    const row = {
      id: randomUUID(),
      user_entity_ref: userEntityRef,
      title,
      created_at: at,
      updated_at: at,
    };
    await this.db('conversations').insert(row);
    return toConversation(row);
  }

  async listConversations(userEntityRef: string): Promise<ChatConversation[]> {
    const rows = await this.db('conversations')
      .where({ user_entity_ref: userEntityRef })
      .orderBy('updated_at', 'desc');
    return rows.map(toConversation);
  }

  /** The conversation, only when `userEntityRef` owns it. */
  async getConversation(
    id: string,
    userEntityRef: string,
  ): Promise<ChatConversation | undefined> {
    const row = await this.db('conversations')
      .where({ id, user_entity_ref: userEntityRef })
      .first();
    return row ? toConversation(row) : undefined;
  }

  async deleteConversation(
    id: string,
    userEntityRef: string,
  ): Promise<boolean> {
    return this.db.transaction(async trx => {
      const owned = await trx('conversations')
        .where({ id, user_entity_ref: userEntityRef })
        .first('id');
      if (!owned) return false;
      await trx('tool_calls').where({ conversation_id: id }).delete();
      await trx('messages').where({ conversation_id: id }).delete();
      await trx('conversations').where({ id }).delete();
      return true;
    });
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db('conversations').where({ id }).update({ title });
  }

  async appendMessage(input: {
    conversationId: string;
    role: ChatRole | 'tool';
    content: string;
    llmCallId?: string;
  }): Promise<StoredMessage> {
    return this.db.transaction(async trx => {
      const last = await trx('messages')
        .where({ conversation_id: input.conversationId })
        .max({ seq: 'seq' })
        .first();
      const row = {
        id: randomUUID(),
        conversation_id: input.conversationId,
        seq: Number(last?.seq ?? 0) + 1,
        role: input.role,
        content: input.content,
        tool_call_id: input.llmCallId ?? null,
        created_at: now(),
      };
      await trx('messages').insert(row);
      await trx('conversations')
        .where({ id: input.conversationId })
        .update({ updated_at: row.created_at });
      return toMessage(row);
    });
  }

  async listMessages(conversationId: string): Promise<StoredMessage[]> {
    const rows = await this.db('messages')
      .where({ conversation_id: conversationId })
      .orderBy('seq', 'asc');
    return rows.map(toMessage);
  }

  /** How many assistant messages follow the last user message. */
  async countAssistantMessagesSinceLastUser(
    conversationId: string,
  ): Promise<number> {
    const lastUser = await this.db('messages')
      .where({ conversation_id: conversationId, role: 'user' })
      .max({ seq: 'seq' })
      .first();
    const row = await this.db('messages')
      .where({ conversation_id: conversationId, role: 'assistant' })
      .andWhere('seq', '>', Number(lastUser?.seq ?? 0))
      .count({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  async insertToolCall(input: NewToolCall & { conversationId: string }) {
    const at = now();
    const id = randomUUID();
    await this.db('tool_calls').insert({
      id,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      position: input.position,
      llm_call_id: input.llmCallId,
      tool_name: input.toolName,
      action_id: input.actionId,
      action_title: input.title,
      action_description: input.description,
      input: JSON.stringify(input.input),
      attributes: JSON.stringify(input.attributes),
      status: input.status,
      error: input.error ?? null,
      created_at: at,
      updated_at: at,
    });
    return (await this.getToolCall(input.conversationId, id))!;
  }

  async getToolCall(
    conversationId: string,
    id: string,
  ): Promise<StoredToolCall | undefined> {
    const row = await this.db('tool_calls')
      .where({ id, conversation_id: conversationId })
      .first();
    return row ? toToolCall(row) : undefined;
  }

  async listToolCalls(conversationId: string): Promise<StoredToolCall[]> {
    const rows = await this.db('tool_calls')
      .where({ conversation_id: conversationId })
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'position', order: 'asc' },
      ]);
    return rows.map(toToolCall);
  }

  /**
   * Moves a call from `from` to `to` in one conditional update and records
   * who decided. Returns false when the call was not in `from`, so that of two
   * requests for the same call only one gets true.
   */
  async decideToolCall(input: {
    conversationId: string;
    id: string;
    from: ChatToolCallStatus;
    to: ChatToolCallStatus;
    decidedBy: string;
    error?: string;
  }): Promise<boolean> {
    const at = now();
    const changed = await this.db('tool_calls')
      .where({
        id: input.id,
        conversation_id: input.conversationId,
        status: input.from,
      })
      .update({
        status: input.to,
        decided_by: input.decidedBy,
        decided_at: at,
        error: input.error ?? null,
        updated_at: at,
      });
    return changed === 1;
  }

  /** Moves a call from `from` to `to`; false when it was not in `from`. */
  async transitionToolCall(input: {
    conversationId: string;
    id: string;
    from: ChatToolCallStatus;
    to: ChatToolCallStatus;
    output?: JsonValue;
    error?: string;
  }): Promise<boolean> {
    const changed = await this.db('tool_calls')
      .where({
        id: input.id,
        conversation_id: input.conversationId,
        status: input.from,
      })
      .update({
        status: input.to,
        output:
          input.output === undefined ? null : JSON.stringify(input.output),
        error: input.error ?? null,
        updated_at: now(),
      });
    return changed === 1;
  }

  /** Calls that have no result yet. */
  async listUnresolvedToolCalls(
    conversationId: string,
  ): Promise<StoredToolCall[]> {
    const rows = await this.db('tool_calls')
      .where({ conversation_id: conversationId })
      .whereIn('status', UNRESOLVED_STATUSES)
      .orderBy('created_at', 'asc');
    return rows.map(toToolCall);
  }
}

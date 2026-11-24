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
  AuditorService,
  AuditorServiceEventSeverityLevel,
  BackstageCredentials,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { ActionsService } from '@backstage/backend-plugin-api/alpha';
import { ConflictError, NotFoundError } from '@backstage/errors';
import type { JsonObject } from '@backstage/types';
import type { Request } from 'express';
import type { ChatConversation, ChatEvent, ChatToolCall } from '../common';
import { ChatStore, StoredToolCall, toApiMessage } from '../database/ChatStore';
import type { AiChatConfig } from '../config';
import {
  LlmClient,
  LlmError,
  LlmMessage,
  LlmToolCall,
} from '../llm/OpenAiCompatibleClient';
import { cutText, limitOutput } from './limits';
import { buildSystemPrompt } from './systemPrompt';
import { ToolCatalog } from './ToolCatalog';

/** The user who sends a request, as the routes found out. */
export interface ChatCaller {
  credentials: BackstageCredentials;
  userEntityRef: string;
  request: Request;
}

/** Where the events of one response go. */
export interface ChatStream {
  emit(event: ChatEvent): void;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
}

export interface ChatServiceOptions {
  store: ChatStore;
  actions: ActionsService;
  llm: LlmClient;
  auditor: AuditorService;
  logger: LoggerService;
  config: AiChatConfig;
}

const MAX_TOOL_NAME_LENGTH = 64;
const NEW_CONVERSATION_TITLE = 'New conversation';
const MAX_TITLE_LENGTH = 60;
const MAX_ERROR_LENGTH = 2000;
/** A call that is `approved` or `running` for longer than this was interrupted. */
const STALE_CALL_MS = 10 * 60 * 1000;

const REJECTED_TEXT =
  'The user rejected this action. It did not run. Do not try to do the same thing in another way; tell the user what was not done.';
const SUPERSEDED_TEXT =
  'The user sent a new message instead of deciding on this action. It did not run.';

type Authorization = { kind: 'read-only' } | { kind: 'approved' };

/**
 * The conversation loop and the approval of actions.
 *
 * What runs without a person: an action whose attributes say `readOnly: true`
 * (the attributes come from the actions service, never from the model). What
 * runs after a decision: every other action, with the input that was stored
 * when the model asked for it, and only for the owner of the conversation.
 */
export class ChatService {
  private readonly store: ChatStore;
  private readonly actions: ActionsService;
  private readonly llm: LlmClient;
  private readonly auditor: AuditorService;
  private readonly logger: LoggerService;
  private readonly config: AiChatConfig;
  /** Conversations with a response in progress on this instance. */
  private readonly active = new Set<string>();

  constructor(options: ChatServiceOptions) {
    this.store = options.store;
    this.actions = options.actions;
    this.llm = options.llm;
    this.auditor = options.auditor;
    this.logger = options.logger;
    this.config = options.config;
  }

  async createConversation(caller: ChatCaller): Promise<ChatConversation> {
    return this.store.createConversation(
      caller.userEntityRef,
      NEW_CONVERSATION_TITLE,
    );
  }

  async listConversations(caller: ChatCaller): Promise<ChatConversation[]> {
    return this.store.listConversations(caller.userEntityRef);
  }

  async getConversation(caller: ChatCaller, id: string) {
    const conversation = await this.requireConversation(caller, id);
    const [messages, toolCalls] = await Promise.all([
      this.store.listMessages(id),
      this.store.listToolCalls(id),
    ]);
    return {
      conversation,
      messages: messages.filter(m => m.role !== 'tool').map(toApiMessage),
      toolCalls: toolCalls.map(toApiToolCall),
    };
  }

  async deleteConversation(caller: ChatCaller, id: string): Promise<void> {
    if (this.active.has(id)) {
      throw new ConflictError('A response of this conversation is in progress');
    }
    const deleted = await this.store.deleteConversation(
      id,
      caller.userEntityRef,
    );
    if (!deleted) throw new NotFoundError('Conversation not found');
  }

  /** A user message: stores it, then runs the loop. */
  async sendMessage(
    caller: ChatCaller,
    conversationId: string,
    content: string,
    stream: ChatStream,
  ): Promise<void> {
    const conversation = await this.requireConversation(caller, conversationId);
    await this.withConversation(conversation.id, async () => {
      await this.supersedeUndecidedCalls(caller, conversation.id, stream);
      const isFirst =
        (await this.store.listMessages(conversation.id)).length === 0;
      const message = await this.store.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        content,
      });
      if (isFirst) {
        await this.store.setTitle(
          conversation.id,
          cutText(content.replace(/\s+/g, ' ').trim(), MAX_TITLE_LENGTH),
        );
      }
      stream.emit({ type: 'user_message', message: toApiMessage(message) });
      await this.runLoop(caller, conversation.id, stream);
      stream.emit({ type: 'done' });
    });
  }

  /**
   * The owner allows a call that waits: the stored input runs, once. Then the
   * loop goes on when no other call of the conversation waits.
   */
  async approve(
    caller: ChatCaller,
    conversationId: string,
    callId: string,
    stream: ChatStream,
  ): Promise<void> {
    const conversation = await this.requireConversation(caller, conversationId);
    await this.withConversation(conversation.id, async () => {
      const waiting = await this.requireToolCall(conversation.id, callId);
      await this.audited(
        'tool-call-approve',
        caller,
        auditMeta(waiting),
        waiting,
        async () => {
          // One conditional update: of two requests only one gets through.
          const changed = await this.store.decideToolCall({
            conversationId: conversation.id,
            id: callId,
            from: 'pending_approval',
            to: 'approved',
            decidedBy: caller.userEntityRef,
          });
          if (!changed) await this.throwNotWaiting(conversation.id, callId);
        },
      );
      const approved = await this.requireToolCall(conversation.id, callId);
      stream.emit({ type: 'tool_call', toolCall: toApiToolCall(approved) });
      const running = await this.store.transitionToolCall({
        conversationId: conversation.id,
        id: callId,
        from: 'approved',
        to: 'running',
      });
      if (running) {
        const event = await this.auditor.createEvent({
          eventId: 'tool-call-invoke',
          severityLevel: severityOf(approved),
          request: caller.request,
          meta: auditMeta(approved),
        });
        try {
          const { failure, superseded } = await this.invokeAndStore(
            caller,
            approved.id,
            conversation.id,
            stream,
            { kind: 'approved' },
          );
          if (superseded) {
            // Someone else finished the call; their request goes on.
            await event.fail({
              error: new Error('The call was no longer running'),
            });
            stream.emit({ type: 'done' });
            return;
          }
          if (failure === undefined) await event.success();
          else await event.fail({ error: new Error(failure) });
        } catch (error) {
          await event.fail({
            error: error instanceof Error ? error : new Error(String(error)),
          });
          throw error;
        }
      }
      await this.continueAfterDecision(caller, conversation.id, stream);
    });
  }

  /** The owner refuses a call that waits. The model is told. */
  async reject(
    caller: ChatCaller,
    conversationId: string,
    callId: string,
    stream: ChatStream,
  ): Promise<void> {
    const conversation = await this.requireConversation(caller, conversationId);
    await this.withConversation(conversation.id, async () => {
      const waiting = await this.requireToolCall(conversation.id, callId);
      await this.audited(
        'tool-call-reject',
        caller,
        auditMeta(waiting),
        waiting,
        async () => {
          const changed = await this.store.decideToolCall({
            conversationId: conversation.id,
            id: callId,
            from: 'pending_approval',
            to: 'rejected',
            decidedBy: caller.userEntityRef,
            error: 'rejected',
          });
          if (!changed) await this.throwNotWaiting(conversation.id, callId);
        },
      );
      const rejected = await this.requireToolCall(conversation.id, callId);
      await this.store.appendMessage({
        conversationId: conversation.id,
        role: 'tool',
        content: REJECTED_TEXT,
        llmCallId: rejected.llmCallId,
      });
      stream.emit({ type: 'tool_result', toolCall: toApiToolCall(rejected) });
      await this.continueAfterDecision(caller, conversation.id, stream);
    });
  }

  private async continueAfterDecision(
    caller: ChatCaller,
    conversationId: string,
    stream: ChatStream,
  ) {
    const unresolved = await this.store.listUnresolvedToolCalls(conversationId);
    if (unresolved.length === 0) {
      await this.runLoop(caller, conversationId, stream);
    }
    stream.emit({ type: 'done' });
  }

  private async requireConversation(caller: ChatCaller, id: string) {
    // The same answer for a conversation that does not exist and one that
    // belongs to someone else.
    const conversation = await this.store.getConversation(
      id,
      caller.userEntityRef,
    );
    if (!conversation) throw new NotFoundError('Conversation not found');
    return conversation;
  }

  private async requireToolCall(conversationId: string, callId: string) {
    const call = await this.store.getToolCall(conversationId, callId);
    if (!call) throw new NotFoundError('Tool call not found');
    return call;
  }

  private async throwNotWaiting(conversationId: string, callId: string) {
    const current = await this.store.getToolCall(conversationId, callId);
    throw new ConflictError(
      `This call is not waiting for a decision${
        current ? ` (it is ${current.status})` : ''
      }`,
    );
  }

  private async withConversation<T>(id: string, fn: () => Promise<T>) {
    if (this.active.has(id)) {
      throw new ConflictError('A response of this conversation is in progress');
    }
    this.active.add(id);
    try {
      return await fn();
    } finally {
      this.active.delete(id);
    }
  }

  /**
   * A call that waits is rejected when the user writes a new message. A call
   * that stayed `approved` or `running` for a long time (the backend stopped
   * in between) is failed; a recent one blocks the new message.
   */
  private async supersedeUndecidedCalls(
    caller: ChatCaller,
    conversationId: string,
    stream: ChatStream,
  ) {
    for (const call of await this.store.listUnresolvedToolCalls(
      conversationId,
    )) {
      if (call.status === 'pending_approval') {
        await this.audited(
          'tool-call-reject',
          caller,
          { ...auditMeta(call), reason: 'superseded' },
          call,
          async () => {
            const changed = await this.store.decideToolCall({
              conversationId,
              id: call.id,
              from: 'pending_approval',
              to: 'rejected',
              decidedBy: caller.userEntityRef,
              error: 'superseded',
            });
            // Another request decided first (for example on another backend
            // instance): treat it like a call that is still being handled.
            if (!changed) {
              throw new ConflictError(
                'Your message was not sent: an action was just decided. Send it again.',
              );
            }
            await this.store.appendMessage({
              conversationId,
              role: 'tool',
              content: SUPERSEDED_TEXT,
              llmCallId: call.llmCallId,
            });
            const rejected = await this.store.getToolCall(
              conversationId,
              call.id,
            );
            // The card of the waiting call loses its buttons.
            if (rejected) {
              stream.emit({
                type: 'tool_result',
                toolCall: toApiToolCall(rejected),
              });
            }
          },
        );
      } else if (Date.now() - Date.parse(call.updatedAt) > STALE_CALL_MS) {
        const changed = await this.store.transitionToolCall({
          conversationId,
          id: call.id,
          from: call.status,
          to: 'failed',
          error: 'The backend stopped before the action finished',
        });
        if (changed) {
          await this.store.appendMessage({
            conversationId,
            role: 'tool',
            content: 'Error: the backend stopped before the action finished.',
            llmCallId: call.llmCallId,
          });
        }
      } else {
        throw new ConflictError('An action of this conversation is running');
      }
    }
  }

  /** The loop: model call, then the calls it asks for, until an answer or a wait. */
  private async runLoop(
    caller: ChatCaller,
    conversationId: string,
    stream: ChatStream,
  ): Promise<void> {
    let catalog: ToolCatalog;
    try {
      catalog = await ToolCatalog.load(
        this.actions,
        caller.credentials,
        this.config.actions,
      );
    } catch (error) {
      this.logger.warn(
        'Could not list the actions',
        error instanceof Error ? error : new Error(String(error)),
      );
      stream.emit({ type: 'error', message: 'Could not list the actions' });
      return;
    }

    for (;;) {
      if (stream.signal.aborted) return;
      const used = await this.store.countAssistantMessagesSinceLastUser(
        conversationId,
      );
      if (used >= this.config.maxTurns) {
        const message = await this.store.appendMessage({
          conversationId,
          role: 'assistant',
          content: `I stopped after ${this.config.maxTurns} model calls for this message. Send another message to go on.`,
        });
        stream.emit({
          type: 'assistant_message',
          message: toApiMessage(message),
        });
        return;
      }

      let result;
      try {
        result = await this.llm.complete({
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(this.config.systemPrompt),
            },
            ...(await this.buildHistory(conversationId)),
          ],
          tools: catalog.tools(),
          signal: stream.signal,
          onText: text => stream.emit({ type: 'text_delta', text }),
        });
      } catch (error) {
        if (stream.signal.aborted) return;
        const message =
          error instanceof LlmError ? error.message : 'The model call failed';
        this.logger.warn(`Model call failed: ${message}`);
        stream.emit({ type: 'error', message });
        return;
      }

      if (!result.content && result.toolCalls.length === 0) {
        stream.emit({
          type: 'notice',
          message: 'The model sent an empty answer',
        });
        return;
      }
      const assistant = await this.store.appendMessage({
        conversationId,
        role: 'assistant',
        content: result.content,
      });
      stream.emit({
        type: 'assistant_message',
        message: toApiMessage(assistant),
      });
      if (result.toolCalls.length === 0) return;

      for (const [position, requested] of result.toolCalls.entries()) {
        const { superseded } = await this.handleRequestedCall({
          caller,
          conversationId,
          messageId: assistant.id,
          position,
          requested,
          catalog,
          stream,
        });
        // Another request changed the call: it goes on with the conversation.
        if (superseded) return;
      }
      const unresolved = await this.store.listUnresolvedToolCalls(
        conversationId,
      );
      if (unresolved.length > 0) return;
    }
  }

  /** Stores one call of the model and runs it, or waits for a decision. */
  private async handleRequestedCall(args: {
    caller: ChatCaller;
    conversationId: string;
    messageId: string;
    position: number;
    requested: LlmToolCall;
    catalog: ToolCatalog;
    stream: ChatStream;
  }): Promise<{ superseded?: boolean }> {
    const { caller, conversationId, requested, catalog, stream } = args;
    const action = catalog.resolve(requested.name);
    const parsed = parseArguments(requested.arguments);
    // The model wrote the name; the columns are 255 characters wide.
    const toolName = requested.name.slice(0, MAX_TOOL_NAME_LENGTH);
    const base = {
      conversationId,
      messageId: args.messageId,
      position: args.position,
      llmCallId: requested.id,
      toolName,
    };

    if (!action || parsed.error !== undefined) {
      const error = !action
        ? `There is no tool named ${cutText(requested.name, 100)}`
        : parsed.error ?? '';
      const call = await this.store.insertToolCall({
        ...base,
        actionId: action?.id ?? toolName,
        title: action?.title ?? toolName,
        description: action?.description ?? '',
        input: parsed.input,
        attributes: action?.attributes ?? {
          readOnly: false,
          destructive: false,
          idempotent: false,
        },
        status: 'failed',
        error,
      });
      await this.store.appendMessage({
        conversationId,
        role: 'tool',
        content: `Error: ${error}`,
        llmCallId: requested.id,
      });
      stream.emit({ type: 'tool_result', toolCall: toApiToolCall(call) });
      return {};
    }

    // Only the attributes from the actions service decide; never the model.
    const readOnly = action.attributes.readOnly === true;
    const call = await this.store.insertToolCall({
      ...base,
      actionId: action.id,
      title: action.title,
      description: action.description,
      input: parsed.input,
      attributes: {
        readOnly,
        destructive: action.attributes.destructive,
        idempotent: action.attributes.idempotent,
      },
      status: readOnly ? 'running' : 'pending_approval',
    });
    if (readOnly) {
      stream.emit({ type: 'tool_call', toolCall: toApiToolCall(call) });
      const { superseded } = await this.invokeAndStore(
        caller,
        call.id,
        conversationId,
        stream,
        { kind: 'read-only' },
      );
      return { superseded };
    }
    stream.emit({ type: 'approval_required', toolCall: toApiToolCall(call) });
    return {};
  }

  /**
   * Runs the stored input of a call that is `running`, stores the result and
   * gives it to the model. The one place where an action is invoked: a call
   * that is not read-only needs the decision of its owner.
   */
  private async invokeAndStore(
    caller: ChatCaller,
    callId: string,
    conversationId: string,
    stream: ChatStream,
    authorization: Authorization,
  ): Promise<{ failure?: string; superseded?: boolean }> {
    const call = await this.store.getToolCall(conversationId, callId);
    if (!call || call.status !== 'running') {
      throw new ConflictError('This call is not running');
    }
    const allowed =
      (call.attributes.readOnly && authorization.kind === 'read-only') ||
      (authorization.kind === 'approved' && Boolean(call.decidedBy));
    if (!allowed) {
      throw new Error(
        `Refusing to run ${call.actionId}: it is not read-only and nobody approved it`,
      );
    }

    let output;
    let failure: string | undefined;
    try {
      ({ output } = await this.actions.invoke({
        id: call.actionId,
        input: call.input,
        credentials: caller.credentials,
      }));
    } catch (error) {
      failure = cutText(
        error instanceof Error ? error.message : String(error),
        MAX_ERROR_LENGTH,
      );
      this.logger.info(`Action ${call.actionId} failed`);
    }

    let toolText: string;
    let changed: boolean;
    if (failure === undefined) {
      const limited = limitOutput(output!, this.config.maxToolOutputChars);
      toolText = limited.text;
      changed = await this.store.transitionToolCall({
        conversationId: call.conversationId,
        id: call.id,
        from: 'running',
        to: 'succeeded',
        output: limited.stored as any,
      });
    } else {
      toolText = `Error: ${failure}`;
      changed = await this.store.transitionToolCall({
        conversationId: call.conversationId,
        id: call.id,
        from: 'running',
        to: 'failed',
        error: failure,
      });
    }
    if (!changed) {
      // Someone else finished the call (for example another backend instance
      // that marked it as interrupted): its result is already stored.
      this.logger.warn(
        `Action ${call.actionId} finished, but call ${call.id} was no longer running; the result is not stored`,
      );
      return { failure, superseded: true };
    }
    await this.store.appendMessage({
      conversationId: call.conversationId,
      role: 'tool',
      content: toolText,
      llmCallId: call.llmCallId,
    });
    const done = await this.store.getToolCall(call.conversationId, call.id);
    stream.emit({ type: 'tool_result', toolCall: toApiToolCall(done!) });
    return { failure };
  }

  /** The conversation history in the form of the model API. */
  private async buildHistory(conversationId: string): Promise<LlmMessage[]> {
    const [messages, calls] = await Promise.all([
      this.store.listMessages(conversationId),
      this.store.listToolCalls(conversationId),
    ]);
    const callsByMessage = new Map<string, StoredToolCall[]>();
    for (const call of calls) {
      const list = callsByMessage.get(call.messageId) ?? [];
      list.push(call);
      callsByMessage.set(call.messageId, list);
    }
    const answered = new Set(
      messages.filter(m => m.role === 'tool').map(m => m.llmCallId),
    );
    const history: LlmMessage[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        history.push({ role: 'user', content: message.content });
      } else if (message.role === 'tool') {
        history.push({
          role: 'tool',
          tool_call_id: message.llmCallId!,
          content: message.content,
        });
      } else {
        const own = (callsByMessage.get(message.id) ?? []).sort(
          (a, b) => a.position - b.position,
        );
        history.push({
          role: 'assistant',
          content: message.content || null,
          ...(own.length > 0
            ? {
                tool_calls: own.map(call => ({
                  id: call.llmCallId,
                  type: 'function' as const,
                  function: {
                    name: call.toolName,
                    arguments: JSON.stringify(call.input),
                  },
                })),
              }
            : {}),
        });
        // A call without a result would make the model server refuse the
        // history.
        for (const call of own) {
          if (!answered.has(call.llmCallId)) {
            history.push({
              role: 'tool',
              tool_call_id: call.llmCallId,
              content: 'No result: the call did not finish.',
            });
          }
        }
      }
    }
    return history;
  }

  /** Records an audit event around `fn`. */
  private async audited<T>(
    eventId: string,
    caller: ChatCaller,
    meta: JsonObject,
    call: StoredToolCall,
    fn: () => Promise<T>,
  ): Promise<T> {
    const event = await this.auditor.createEvent({
      eventId,
      severityLevel: severityOf(call),
      request: caller.request,
      meta,
    });
    try {
      const result = await fn();
      await event.success();
      return result;
    } catch (error) {
      await event.fail({
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }
}

function severityOf(call: StoredToolCall): AuditorServiceEventSeverityLevel {
  return call.attributes.destructive ? 'high' : 'medium';
}

function auditMeta(call: StoredToolCall): JsonObject {
  return {
    conversationId: call.conversationId,
    toolCallId: call.id,
    actionId: call.actionId,
    destructive: call.attributes.destructive,
    idempotent: call.attributes.idempotent,
  };
}

function parseArguments(text: string): { input: JsonObject; error?: string } {
  if (!text.trim()) return { input: {} };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { input: {}, error: 'The arguments are not a JSON object' };
    }
    return { input: value as JsonObject };
  } catch {
    return { input: {}, error: 'The arguments are not valid JSON' };
  }
}

export function toApiToolCall(call: StoredToolCall): ChatToolCall {
  return {
    id: call.id,
    messageId: call.messageId,
    actionId: call.actionId,
    title: call.title,
    description: call.description,
    input: call.input,
    attributes: call.attributes,
    status: call.status,
    output: call.output,
    error: call.error,
    decidedBy: call.decidedBy,
    decidedAt: call.decidedAt,
    createdAt: call.createdAt,
  };
}

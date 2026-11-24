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

import { mockServices } from '@backstage/backend-test-utils';
import { ConflictError, NotFoundError } from '@backstage/errors';
import type { Knex } from 'knex';
import { ChatStore } from '../database/ChatStore';
import type { AiChatConfig } from '../config';
import {
  caller,
  createMigratedDb,
  FakeActions,
  recordStream,
  ScriptedLlm,
  ScriptedAnswer,
} from '../__testUtils__';
import { ChatService } from './ChatService';
import type { ChatEvent } from '../common';

const readOnlyAction = {
  id: 'demo:list-things',
  title: 'List things',
  readOnly: true,
  run: () => ({ things: ['a', 'b'] }),
};
const writeAction = {
  id: 'demo:change-thing',
  title: 'Change a thing',
  readOnly: false,
  destructive: true,
  run: (input: any) => ({ changed: input.name }),
};

function baseConfig(overrides: Partial<AiChatConfig> = {}): AiChatConfig {
  return {
    llm: { baseUrl: 'http://llm.test/v1', model: 'm', timeoutMs: 1000 },
    maxTurns: 10,
    actions: { include: [], exclude: [] },
    maxToolOutputChars: 20000,
    ...overrides,
  };
}

const types = (events: ChatEvent[]) => events.map(e => e.type);

describe('ChatService', () => {
  let db: Knex;
  let store: ChatStore;
  let auditor: ReturnType<typeof mockServices.auditor.mock>;
  let events: Array<{ eventId: string; meta?: any; request?: unknown }>;

  beforeEach(async () => {
    db = await createMigratedDb();
    store = new ChatStore(db);
    events = [];
    auditor = mockServices.auditor.mock({
      createEvent: jest.fn(async options => {
        events.push(options);
        return { success: jest.fn(), fail: jest.fn() };
      }),
    });
  });

  function setup(
    answers: ScriptedAnswer[],
    actions = new FakeActions([readOnlyAction, writeAction]),
    config: Partial<AiChatConfig> = {},
  ) {
    const llm = new ScriptedLlm(answers);
    const service = new ChatService({
      store,
      actions,
      llm,
      auditor,
      logger: mockServices.logger.mock(),
      config: baseConfig(config),
    });
    return { service, llm, actions };
  }

  async function start(service: ChatService, user = caller()) {
    const conversation = await service.createConversation(user);
    return conversation.id;
  }

  describe('read-only actions', () => {
    it('run at once, with the credentials of the user, and the loop goes on', async () => {
      const { service, llm, actions } = setup([
        { calls: [{ name: 'demo_list-things', args: {} }] },
        'There are two things.',
      ]);
      const alice = caller();
      const id = await start(service, alice);
      const stream = recordStream();

      await service.sendMessage(alice, id, 'list the things', stream);

      expect(actions.invocations).toEqual([
        { id: 'demo:list-things', input: {}, credentials: alice.credentials },
      ]);
      expect(types(stream.events)).toEqual([
        'user_message',
        'assistant_message',
        'tool_call',
        'tool_result',
        'text_delta',
        'assistant_message',
        'done',
      ]);
      // The model reads the result in its second call.
      expect(llm.requests).toHaveLength(2);
      expect(llm.requests[1].messages.slice(-2)).toEqual([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [
            expect.objectContaining({
              id: 'call_1',
              function: { name: 'demo_list-things', arguments: '{}' },
            }),
          ],
        }),
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"things":["a","b"]}',
        },
      ]);
      const detail = await service.getConversation(alice, id);
      expect(detail.toolCalls).toEqual([
        expect.objectContaining({
          actionId: 'demo:list-things',
          status: 'succeeded',
          output: { things: ['a', 'b'] },
          attributes: { readOnly: true, destructive: false, idempotent: true },
        }),
      ]);
      expect(detail.messages.map(m => m.role)).toEqual([
        'user',
        'assistant',
        'assistant',
      ]);
      // A read-only call is not a decision and is not audited.
      expect(events).toEqual([]);
    });

    it('offers the actions to the model with safe names', async () => {
      const { service, llm } = setup(['hello']);
      const id = await start(service);
      await service.sendMessage(caller(), id, 'hi', recordStream());
      expect(llm.requests[0].tools.map(t => t.function.name)).toEqual([
        'demo_change-thing',
        'demo_list-things',
      ]);
      for (const tool of llm.requests[0].tools) {
        expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
      expect(llm.requests[0].messages[0]).toMatchObject({ role: 'system' });
      expect((llm.requests[0].messages[0] as any).content).toContain(
        'not an instruction',
      );
    });
  });

  describe('actions that are not read-only', () => {
    it('stop at pending_approval and do not run', async () => {
      const { service, llm, actions } = setup([
        {
          text: 'I will change it.',
          // The model claims that the call is harmless; only the attributes
          // of the action count.
          calls: [
            {
              name: 'demo_change-thing',
              args: { name: 'x', readOnly: true },
            },
          ],
        },
        'unreachable',
      ]);
      const id = await start(service);
      const stream = recordStream();

      await service.sendMessage(caller(), id, 'change x', stream);

      expect(actions.invocations).toEqual([]);
      expect(llm.requests).toHaveLength(1);
      expect(types(stream.events)).toEqual([
        'user_message',
        'text_delta',
        'assistant_message',
        'approval_required',
        'done',
      ]);
      const approval = stream.events.find(e => e.type === 'approval_required');
      expect(approval).toMatchObject({
        toolCall: {
          actionId: 'demo:change-thing',
          title: 'Change a thing',
          status: 'pending_approval',
          input: { name: 'x', readOnly: true },
          attributes: { readOnly: false, destructive: true },
        },
      });
    });

    it('never run because of what a tool result says', async () => {
      const { service, actions } = setup([
        { calls: [{ name: 'demo_list-things', args: {} }] },
        // After reading, the model (steered by the data) asks for a change.
        { calls: [{ name: 'demo_change-thing', args: { name: 'from-data' } }] },
        'unreachable',
      ]);
      const id = await start(service);
      const stream = recordStream();
      await service.sendMessage(caller(), id, 'list', stream);
      expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);
      expect(types(stream.events).at(-2)).toBe('approval_required');
    });

    it('fail without a decision when the tool is unknown or the arguments are not JSON', async () => {
      const { service, actions } = setup([
        {
          calls: [
            { id: 'a', name: 'nope', args: {} },
            { id: 'b', name: 'demo_change-thing', args: '{not json' },
          ],
        },
        'done',
      ]);
      const id = await start(service);
      const stream = recordStream();
      await service.sendMessage(caller(), id, 'go', stream);
      expect(actions.invocations).toEqual([]);
      const { toolCalls } = await service.getConversation(caller(), id);
      expect(toolCalls.map(c => [c.status, c.error])).toEqual([
        ['failed', 'There is no tool named nope'],
        ['failed', 'The arguments are not valid JSON'],
      ]);
    });
  });

  describe('approval', () => {
    async function withPendingCall(extra: ScriptedAnswer[] = ['All done.']) {
      const setupResult = setup([
        { calls: [{ name: 'demo_change-thing', args: { name: 'stored' } }] },
        ...extra,
      ]);
      const alice = caller('user:default/alice', { id: 'req-1' } as any);
      const id = await start(setupResult.service, alice);
      await setupResult.service.sendMessage(
        alice,
        id,
        'change it',
        recordStream(),
      );
      const { toolCalls } = await setupResult.service.getConversation(
        alice,
        id,
      );
      return { ...setupResult, alice, id, callId: toolCalls[0].id };
    }

    it('runs the stored input with the credentials of the owner, then continues', async () => {
      const { service, llm, actions, alice, id, callId } =
        await withPendingCall();
      events.length = 0;
      const stream = recordStream();

      await service.approve(alice, id, callId, stream);

      expect(actions.invocations).toEqual([
        {
          id: 'demo:change-thing',
          input: { name: 'stored' },
          credentials: alice.credentials,
        },
      ]);
      expect(types(stream.events)).toEqual([
        'tool_call',
        'tool_result',
        'text_delta',
        'assistant_message',
        'done',
      ]);
      expect(llm.requests).toHaveLength(2);
      expect(llm.requests[1].messages.at(-1)).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"changed":"stored"}',
      });
      const { toolCalls } = await service.getConversation(alice, id);
      expect(toolCalls[0]).toMatchObject({
        status: 'succeeded',
        decidedBy: 'user:default/alice',
        output: { changed: 'stored' },
      });
      expect(toolCalls[0].decidedAt).toEqual(expect.any(String));
      // Approve and invoke are audited, with the request of the user.
      expect(events.map(e => e.eventId)).toEqual([
        'tool-call-approve',
        'tool-call-invoke',
      ]);
      expect(events[0].request).toBe(alice.request);
      expect(events[1].meta).toMatchObject({
        actionId: 'demo:change-thing',
        toolCallId: callId,
        destructive: true,
      });
      // The input is not copied into the audit log.
      expect(JSON.stringify(events)).not.toContain('stored');
    });

    it('does not use anything but the stored input, whatever the actions list says now', async () => {
      const { service, actions, alice, id, callId } = await withPendingCall();
      actions.setActions([
        { ...writeAction, run: (input: any) => ({ got: input }) },
      ]);
      await service.approve(alice, id, callId, recordStream());
      expect(actions.invocations.at(-1)?.input).toEqual({ name: 'stored' });
    });

    it('is accepted only once', async () => {
      const { service, actions, alice, id, callId } = await withPendingCall();
      const results = await Promise.allSettled([
        service.approve(alice, id, callId, recordStream()),
        service.approve(alice, id, callId, recordStream()),
      ]);
      expect(results.map(r => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(
        (results.find(r => r.status === 'rejected') as PromiseRejectedResult)
          .reason,
      ).toBeInstanceOf(ConflictError);
      expect(actions.invocations).toHaveLength(1);

      // A later request fails too, and so does a rejection.
      await expect(
        service.approve(alice, id, callId, recordStream()),
      ).rejects.toThrow(/is not waiting for a decision \(it is succeeded\)/);
      await expect(
        service.reject(alice, id, callId, recordStream()),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(actions.invocations).toHaveLength(1);
    });

    it('is accepted only once even when the two requests use separate services', async () => {
      // Two backend instances share the database but not the memory.
      const first = await withPendingCall();
      const second = new ChatService({
        store,
        actions: first.actions,
        llm: new ScriptedLlm(['ok']),
        auditor,
        logger: mockServices.logger.mock(),
        config: baseConfig(),
      });
      const results = await Promise.allSettled([
        first.service.approve(
          first.alice,
          first.id,
          first.callId,
          recordStream(),
        ),
        second.approve(first.alice, first.id, first.callId, recordStream()),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(first.actions.invocations).toHaveLength(1);
    });

    it('is accepted only from the owner of the conversation', async () => {
      const { service, actions, id, callId } = await withPendingCall();
      const bob = caller('user:default/bob');
      await expect(
        service.approve(bob, id, callId, recordStream()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        service.reject(bob, id, callId, recordStream()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.getConversation(bob, id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        service.sendMessage(bob, id, 'hi', recordStream()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.deleteConversation(bob, id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(actions.invocations).toEqual([]);
      expect(await service.listConversations(bob)).toEqual([]);
      const detail = await service.getConversation(caller(), id);
      expect(detail.toolCalls[0].status).toBe('pending_approval');
    });

    it('does not accept a call of another conversation', async () => {
      const { service, alice, callId } = await withPendingCall();
      const otherId = await start(service, alice);
      await expect(
        service.approve(alice, otherId, callId, recordStream()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tells the model about a failure and goes on', async () => {
      const { service, llm, actions, alice, id, callId } =
        await withPendingCall();
      actions.setActions([
        {
          ...writeAction,
          run: () => {
            throw new Error('Request failed with 403 Forbidden');
          },
        },
      ]);
      events.length = 0;
      const failEvents: any[] = [];
      auditor.createEvent.mockImplementation(async () => ({
        success: jest.fn(),
        fail: jest.fn(async o => {
          failEvents.push(o.error.message);
        }),
      }));
      const stream = recordStream();
      await service.approve(alice, id, callId, stream);
      const { toolCalls } = await service.getConversation(alice, id);
      expect(toolCalls[0]).toMatchObject({
        status: 'failed',
        error: 'Request failed with 403 Forbidden',
      });
      expect(llm.requests.at(-1)?.messages.at(-1)).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Error: Request failed with 403 Forbidden',
      });
      expect(failEvents).toEqual(['Request failed with 403 Forbidden']);
      expect(types(stream.events).at(-1)).toBe('done');
    });

    it('waits for the other calls before the model goes on', async () => {
      const { service, llm, actions } = setup([
        {
          calls: [
            { id: 'one', name: 'demo_change-thing', args: { name: '1' } },
            { id: 'two', name: 'demo_change-thing', args: { name: '2' } },
          ],
        },
        'Both done.',
      ]);
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'change both', recordStream());
      const { toolCalls } = await service.getConversation(alice, id);
      expect(toolCalls).toHaveLength(2);

      await service.approve(alice, id, toolCalls[0].id, recordStream());
      expect(llm.requests).toHaveLength(1);
      await service.reject(alice, id, toolCalls[1].id, recordStream());
      expect(llm.requests).toHaveLength(2);
      expect(actions.invocations.map(i => i.input)).toEqual([{ name: '1' }]);
      expect(llm.requests[1].messages.slice(-2)).toEqual([
        expect.objectContaining({ role: 'tool', tool_call_id: 'one' }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'two',
          content: expect.stringContaining('The user rejected'),
        }),
      ]);
    });
  });

  describe('rejection', () => {
    it('does not run the action and tells the model', async () => {
      const { service, llm, actions } = setup([
        { calls: [{ name: 'demo_change-thing', args: { name: 'x' } }] },
        'Okay, I did nothing.',
      ]);
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'change x', recordStream());
      const { toolCalls } = await service.getConversation(alice, id);
      events.length = 0;
      const stream = recordStream();

      await service.reject(alice, id, toolCalls[0].id, stream);

      expect(actions.invocations).toEqual([]);
      expect(types(stream.events)).toEqual([
        'tool_result',
        'text_delta',
        'assistant_message',
        'done',
      ]);
      expect(llm.requests[1].messages.at(-1)).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: expect.stringContaining('The user rejected this action'),
      });
      const after = await service.getConversation(alice, id);
      expect(after.toolCalls[0]).toMatchObject({
        status: 'rejected',
        decidedBy: 'user:default/alice',
      });
      expect(events.map(e => e.eventId)).toEqual(['tool-call-reject']);
    });
  });

  describe('a new message', () => {
    it('rejects a call that waits, as superseded, and tells the model', async () => {
      const { service, llm, actions } = setup([
        { calls: [{ name: 'demo_change-thing', args: { name: 'x' } }] },
        'Fine, what else?',
      ]);
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'change x', recordStream());
      events.length = 0;

      await service.sendMessage(alice, id, 'never mind', recordStream());

      const { toolCalls } = await service.getConversation(alice, id);
      expect(toolCalls[0]).toMatchObject({
        status: 'rejected',
        error: 'superseded',
      });
      expect(actions.invocations).toEqual([]);
      const history = llm.requests[1].messages;
      expect(history.map(m => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'user',
      ]);
      expect(events).toEqual([
        expect.objectContaining({
          eventId: 'tool-call-reject',
          meta: expect.objectContaining({ reason: 'superseded' }),
        }),
      ]);
      // The call can no longer be approved.
      await expect(
        service.approve(alice, id, toolCalls[0].id, recordStream()),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(actions.invocations).toEqual([]);
    });

    it('is refused while a response of the same conversation runs', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>(r => (release = r));
      const { service, llm } = setup([]);
      llm.complete = async () => {
        await gate;
        return { content: 'late', toolCalls: [] };
      };
      const alice = caller();
      const id = await start(service, alice);
      const first = service.sendMessage(alice, id, 'one', recordStream());
      await new Promise(r => setTimeout(r, 50));
      await expect(
        service.sendMessage(alice, id, 'two', recordStream()),
      ).rejects.toBeInstanceOf(ConflictError);
      release();
      await first;
    });
  });

  describe('limits', () => {
    it('stops after maxTurns model calls and says so', async () => {
      const { service, llm, actions } = setup(
        [{ calls: [{ name: 'demo_list-things', args: {} }] }],
        undefined,
        { maxTurns: 3 },
      );
      const alice = caller();
      const id = await start(service, alice);
      const stream = recordStream();
      await service.sendMessage(alice, id, 'loop', stream);
      expect(llm.requests).toHaveLength(3);
      expect(actions.invocations).toHaveLength(3);
      const { messages } = await service.getConversation(alice, id);
      expect(messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('stopped after 3 model calls'),
      });
      expect(types(stream.events).at(-1)).toBe('done');

      // The count starts again with the next user message.
      await service.sendMessage(alice, id, 'again', recordStream());
      expect(llm.requests).toHaveLength(6);
    });

    it('counts the model calls after an approval too', async () => {
      const { service, llm } = setup(
        [
          { calls: [{ name: 'demo_change-thing', args: { name: 'x' } }] },
          { calls: [{ name: 'demo_list-things', args: {} }] },
        ],
        undefined,
        { maxTurns: 2 },
      );
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'go', recordStream());
      const { toolCalls } = await service.getConversation(alice, id);
      await service.approve(alice, id, toolCalls[0].id, recordStream());
      expect(llm.requests).toHaveLength(2);
      const { messages } = await service.getConversation(alice, id);
      expect(messages.at(-1)?.content).toContain('stopped after 2 model calls');
    });

    it('cuts the output that is stored and sent to the model, and says so', async () => {
      const big = { text: 'x'.repeat(500) };
      const { service, llm } = setup(
        [{ calls: [{ name: 'demo_list-things', args: {} }] }, 'ok'],
        new FakeActions([{ ...readOnlyAction, run: () => big }]),
        { maxToolOutputChars: 100 },
      );
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'list', recordStream());
      const { toolCalls } = await service.getConversation(alice, id);
      const length = JSON.stringify(big).length;
      expect(toolCalls[0].output).toEqual({
        truncated: true,
        originalLength: length,
        text: JSON.stringify(big).slice(0, 100),
      });
      const toolMessage = llm.requests[1].messages.at(-1) as any;
      expect(toolMessage.content).toContain(
        `The output was cut: 100 of ${length} characters`,
      );
      expect(toolMessage.content.length).toBeLessThan(200);
    });
  });

  describe('actions that the chat offers', () => {
    it('apply include and exclude patterns', async () => {
      const actions = new FakeActions([
        { id: 'catalog:get-entity', readOnly: true },
        { id: 'catalog:register-entity' },
        { id: 'temporal:list-workflows', readOnly: true },
        { id: 'temporal:start-workflow' },
      ]);
      const { service, llm } = setup(['hi'], actions, {
        actions: {
          include: ['catalog:*', 'temporal:list-*'],
          exclude: ['*:register-*'],
        },
      });
      const id = await start(service);
      await service.sendMessage(caller(), id, 'hi', recordStream());
      expect(llm.requests[0].tools.map(t => t.function.name)).toEqual([
        'catalog_get-entity',
        'temporal_list-workflows',
      ]);
    });

    it('leave out an action that needs secrets', async () => {
      const actions = new FakeActions([
        { id: 'demo:list-things', readOnly: true },
        { id: 'demo:needs-secret', secrets: true },
      ]);
      const { service, llm } = setup(['hi'], actions);
      const id = await start(service);
      await service.sendMessage(caller(), id, 'hi', recordStream());
      expect(llm.requests[0].tools.map(t => t.function.name)).toEqual([
        'demo_list-things',
      ]);
    });
  });

  describe('failures of the model', () => {
    it('are shown as an error event and leave the conversation usable', async () => {
      const { service, llm } = setup([
        () => {
          throw new Error('boom');
        },
        'recovered',
      ]);
      const alice = caller();
      const id = await start(service, alice);
      const first = recordStream();
      await service.sendMessage(alice, id, 'hello', first);
      expect(first.events.find(e => e.type === 'error')).toEqual({
        type: 'error',
        message: 'The model call failed',
      });
      await service.sendMessage(alice, id, 'again', recordStream());
      expect(llm.requests).toHaveLength(2);
    });
  });

  describe('long values from the model', () => {
    it('are cut before they are stored for an unknown tool', async () => {
      const long = 'x'.repeat(400);
      const { service } = setup([
        { calls: [{ id: 'a', name: long, args: {} }] },
        'done',
      ]);
      const id = await start(service);
      await service.sendMessage(caller(), id, 'go', recordStream());
      const { toolCalls } = await service.getConversation(caller(), id);
      expect(toolCalls[0].actionId).toBe('x'.repeat(64));
      expect(toolCalls[0].title).toBe('x'.repeat(64));
      const row = await db('tool_calls').first();
      expect(row.tool_name).toHaveLength(64);
    });
  });

  describe('several calls in one answer', () => {
    async function writeThenRead() {
      const setupResult = setup([
        {
          calls: [
            { id: 'w', name: 'demo_change-thing', args: { name: 'x' } },
            { id: 'r', name: 'demo_list-things', args: {} },
          ],
        },
        'All done.',
      ]);
      const alice = caller();
      const id = await start(setupResult.service, alice);
      const stream = recordStream();
      await setupResult.service.sendMessage(alice, id, 'go', stream);
      return { ...setupResult, alice, id, stream };
    }

    it('runs the read at once and keeps the write waiting', async () => {
      const { actions, service, alice, id, stream, llm } =
        await writeThenRead();
      expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);
      expect(llm.requests).toHaveLength(1);
      expect(types(stream.events)).toEqual([
        'user_message',
        'assistant_message',
        'approval_required',
        'tool_call',
        'tool_result',
        'done',
      ]);
      const { toolCalls } = await service.getConversation(alice, id);
      expect(toolCalls.map(c => c.status)).toEqual([
        'pending_approval',
        'succeeded',
      ]);
    });

    it('sends the calls in position order, with the right IDs, after approve', async () => {
      const { actions, service, alice, id, llm } = await writeThenRead();
      const { toolCalls } = await service.getConversation(alice, id);
      await service.approve(alice, id, toolCalls[0].id, recordStream());
      expect(actions.invocations.map(i => i.id)).toEqual([
        'demo:list-things',
        'demo:change-thing',
      ]);
      const history = llm.requests[1].messages as any[];
      const assistant = history.find(m => m.role === 'assistant');
      expect(
        assistant.tool_calls.map((c: any) => [c.id, c.function.name]),
      ).toEqual([
        ['w', 'demo_change-thing'],
        ['r', 'demo_list-things'],
      ]);
      const toolMessages = history.filter(m => m.role === 'tool');
      expect(toolMessages.map(m => m.tool_call_id).sort()).toEqual(['r', 'w']);
      expect(toolMessages.find(m => m.tool_call_id === 'w').content).toBe(
        '{"changed":"x"}',
      );
      expect(toolMessages.find(m => m.tool_call_id === 'r').content).toBe(
        '{"things":["a","b"]}',
      );
    });

    it('answers both IDs when the write is superseded', async () => {
      const { actions, service, alice, id, llm } = await writeThenRead();
      const stream = recordStream();
      await service.sendMessage(alice, id, 'never mind', stream);
      expect(actions.invocations.map(i => i.id)).toEqual(['demo:list-things']);
      // The card of the waiting call gets its new state.
      expect(
        stream.events.find(
          e => e.type === 'tool_result' && e.toolCall.error === 'superseded',
        ),
      ).toMatchObject({ toolCall: { status: 'rejected' } });
      const history = llm.requests[1].messages as any[];
      const assistant = history.find(m => m.role === 'assistant');
      expect(assistant.tool_calls.map((c: any) => c.id)).toEqual(['w', 'r']);
      const toolMessages = history.filter(m => m.role === 'tool');
      expect(toolMessages.map(m => m.tool_call_id).sort()).toEqual(['r', 'w']);
      expect(toolMessages.find(m => m.tool_call_id === 'w').content).toContain(
        'did not run',
      );
      // Every tool message comes before the new user message.
      expect(history.at(-1)).toMatchObject({
        role: 'user',
        content: 'never mind',
      });
    });
  });

  describe('when another instance changes a call at the same time', () => {
    it('does not store a result for a call that is no longer running', async () => {
      const logger = mockServices.logger.mock();
      const actions = new FakeActions([
        {
          ...readOnlyAction,
          run: async () => {
            // Another instance marks the call as interrupted meanwhile.
            await db('tool_calls').update({ status: 'failed' });
            return { late: true };
          },
        },
      ]);
      const llm = new ScriptedLlm([
        { calls: [{ name: 'demo_list-things', args: {} }] },
        'unreachable',
      ]);
      const service = new ChatService({
        store,
        actions,
        llm,
        auditor,
        logger,
        config: baseConfig(),
      });
      const alice = caller();
      const id = await start(service, alice);
      const stream = recordStream();
      await service.sendMessage(alice, id, 'list', stream);
      expect(types(stream.events)).not.toContain('tool_result');
      expect(
        (await store.listMessages(id)).filter(m => m.role === 'tool'),
      ).toEqual([]);
      // The other request goes on; this one does not call the model again.
      expect(llm.requests).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('was no longer running'),
      );
    });

    it('does not go on after an approval when the call was finished by another instance', async () => {
      const actions = new FakeActions([
        {
          ...writeAction,
          run: async () => {
            await db('tool_calls').update({ status: 'failed' });
            return { late: true };
          },
        },
      ]);
      const llm = new ScriptedLlm([
        { calls: [{ name: 'demo_change-thing', args: { name: 'x' } }] },
        'unreachable',
      ]);
      const service = new ChatService({
        store,
        actions,
        llm,
        auditor,
        logger: mockServices.logger.mock(),
        config: baseConfig(),
      });
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'go', recordStream());
      const { toolCalls } = await service.getConversation(alice, id);
      const stream = recordStream();
      await service.approve(alice, id, toolCalls[0].id, stream);
      expect(llm.requests).toHaveLength(1);
      expect(types(stream.events)).not.toContain('tool_result');
      expect(types(stream.events).at(-1)).toBe('done');
      expect(
        (await store.listMessages(id)).filter(m => m.role === 'tool'),
      ).toEqual([]);
    });

    it('refuses a new message when a waiting call was decided meanwhile', async () => {
      const { service } = setup([
        { calls: [{ name: 'demo_change-thing', args: { name: 'x' } }] },
        'unreachable',
      ]);
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(alice, id, 'go', recordStream());
      jest.spyOn(store, 'decideToolCall').mockResolvedValue(false);
      await expect(
        service.sendMessage(alice, id, 'again', recordStream()),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(
        (await store.listMessages(id)).filter(m => m.role === 'user'),
      ).toHaveLength(1);
    });
  });

  describe('conversations', () => {
    it('are titled with the first message and deleted with their data', async () => {
      const { service } = setup(['hi']);
      const alice = caller();
      const id = await start(service, alice);
      await service.sendMessage(
        alice,
        id,
        '  What   is\nthis?  ',
        recordStream(),
      );
      expect(await service.listConversations(alice)).toEqual([
        expect.objectContaining({ id, title: 'What is this?' }),
      ]);
      await service.deleteConversation(alice, id);
      expect(await service.listConversations(alice)).toEqual([]);
      const remaining = await db('messages').count({ n: '*' }).first();
      // PostgreSQL returns a count as a string.
      expect(Number(remaining?.n)).toBe(0);
    });
  });
});

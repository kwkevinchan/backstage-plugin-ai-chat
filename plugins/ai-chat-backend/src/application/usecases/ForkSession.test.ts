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
  insertStatesOf,
  type Item,
  type ItemBody,
} from '@kwkevinchan/ai-chat-harness';
import type { Principal, Session } from '../../domain';
import type { AuditEvent } from '../ports';
import { ForkSession } from './ForkSession';

const bob: Principal = {
  userRef: 'user:default/bob',
  ownershipRefs: ['user:default/bob'],
  credentials: {} as Principal['credentials'],
};

const sourceSession: Session = {
  id: 's-src',
  ownerRef: 'user:default/bob',
  agentId: 'default',
  title: 'Original',
  enabledToolsets: ['read'],
  pinned: false,
  createdAt: '2026-11-26T00:00:00.000Z',
  updatedAt: '2026-11-26T00:00:00.000Z',
};

function makeHarness(opts: {
  sourceItems?: Item[];
  seedItems?: (sessionId: string, drafts: ItemBody[]) => Promise<Item[]>;
  deleteSession?: jest.Mock;
}) {
  const auditEvents: Array<AuditEvent & { outcome?: string; reason?: string }> =
    [];
  const createdSessions: Session[] = [];
  const deleteSession = opts.deleteSession ?? jest.fn(async () => {});
  const seedItems = opts.seedItems ?? jest.fn(async () => []);

  const usecase = new ForkSession({
    sessions: {
      get: jest.fn(async () => sourceSession),
      listByOwner: jest.fn(async () => []),
      create: jest.fn(async input => {
        const created: Session = {
          id: input.id ?? 'generated',
          ownerRef: input.ownerRef,
          agentId: input.agentId,
          title: input.title,
          entityRef: input.entityRef,
          enabledToolsets: [...(input.enabledToolsets ?? [])],
          pinned: false,
          createdAt: '2026-11-26T00:01:00.000Z',
          updatedAt: '2026-11-26T00:01:00.000Z',
        };
        createdSessions.push(created);
        return created;
      }),
      update: jest.fn(async () => sourceSession),
      delete: deleteSession,
      seedItems,
    } as never,
    items: {
      read: jest.fn(async () => opts.sourceItems ?? []),
      append: jest.fn(),
      latest: jest.fn(),
    } as never,
    attachments: {
      copy: jest.fn(async () => new Map()),
    } as never,
    shares: {
      listBySession: jest.fn(async () => []),
    } as never,
    access: {
      canReadSession: jest.fn(async () => true),
      usableToolsets: jest.fn(
        async ({ toolsetIds }: { toolsetIds: string[] }) => toolsetIds,
      ),
    } as never,
    agents: {
      default: { id: 'default' },
      find: jest.fn(() => ({ id: 'default' })),
      toolsets: jest.fn(() => [{ id: 'read', title: 'Read', default: true }]),
    } as never,
    entities: {
      exists: jest.fn(async () => true),
    } as never,
    audit: {
      begin: jest.fn(async event => {
        const record: AuditEvent & { outcome?: string; reason?: string } = {
          ...event,
        };
        auditEvents.push(record);
        return {
          success: async () => {
            record.outcome = 'success';
          },
          fail: async (reason: string) => {
            record.outcome = 'fail';
            record.reason = reason;
          },
        };
      }),
    },
    clock: {
      now: () => new Date('2026-11-26T00:01:00.000Z'),
    },
    ids: {
      next: () => 's-fork-pre',
    },
  });

  return { usecase, auditEvents, deleteSession, seedItems, createdSessions };
}

describe('ForkSession', () => {
  it('deletes the created session, fails the audit span with the same id, and rethrows when seedItems fails', async () => {
    const boom = new Error('disk full');
    const t = '2026-11-26T00:00:00.000Z';
    const { usecase, auditEvents, deleteSession } = makeHarness({
      sourceItems: [
        {
          sessionId: 's-src',
          seq: 1,
          createdAt: t,
          kind: 'user_message',
          text: 'hi',
        },
        {
          sessionId: 's-src',
          seq: 2,
          createdAt: t,
          kind: 'agent_message',
          text: 'hello',
        },
      ],
      seedItems: jest.fn(async () => {
        throw boom;
      }),
    });

    await expect(
      usecase.execute({ principal: bob, sessionId: sourceSession.id }),
    ).rejects.toThrow('disk full');

    expect(deleteSession).toHaveBeenCalledWith('s-fork-pre');
    expect(auditEvents).toEqual([
      expect.objectContaining({
        eventId: 'session-fork',
        sessionId: 's-fork-pre',
        sourceSessionId: 's-src',
        outcome: 'fail',
        reason: 'disk full',
      }),
    ]);
  });

  it('notes cleanup failure in the audit fail reason when deleting the orphan session also fails', async () => {
    const t = '2026-11-26T00:00:00.000Z';
    const { usecase, auditEvents } = makeHarness({
      sourceItems: [
        {
          sessionId: 's-src',
          seq: 1,
          createdAt: t,
          kind: 'user_message',
          text: 'hi',
        },
      ],
      seedItems: jest.fn(async () => {
        throw new Error('insert failed');
      }),
      deleteSession: jest.fn(async () => {
        throw new Error('db unreachable');
      }),
    });

    await expect(
      usecase.execute({ principal: bob, sessionId: sourceSession.id }),
    ).rejects.toThrow('insert failed');

    expect(auditEvents[0]).toMatchObject({
      eventId: 'session-fork',
      sessionId: 's-fork-pre',
      outcome: 'fail',
    });
    expect(auditEvents[0].reason).toContain('insert failed');
    expect(auditEvents[0].reason).toContain('cleanup failed');
  });

  it('keeps an unread inserted message unread after remapping readUpToSeq', async () => {
    const t = '2026-11-26T00:00:00.000Z';
    let seeded: ItemBody[] = [];
    const { usecase } = makeHarness({
      sourceItems: [
        {
          sessionId: 's-src',
          seq: 1,
          createdAt: t,
          runId: 'r-1',
          kind: 'user_message',
          text: 'start',
        },
        {
          sessionId: 's-src',
          seq: 2,
          createdAt: t,
          runId: 'r-1',
          kind: 'tool_call',
          callId: 'c1',
          toolId: 'demo:read',
          input: {},
          schemaHash: 'h',
          policy: 'allow',
          readOnly: true,
          step: 0,
          position: 0,
        },
        {
          sessionId: 's-src',
          seq: 3,
          createdAt: t,
          runId: 'r-1',
          kind: 'tool_result',
          callId: 'c1',
          status: 'ok',
          output: {},
        },
        {
          sessionId: 's-src',
          seq: 4,
          createdAt: t,
          runId: 'r-1',
          kind: 'agent_message',
          text: 'done',
          readUpToSeq: 1,
        },
        {
          sessionId: 's-src',
          seq: 5,
          createdAt: t,
          runId: 'r-1',
          kind: 'user_message',
          delivery: 'inserted',
          text: 'too late',
        },
      ],
      seedItems: jest.fn(async (_id: string, bodies: ItemBody[]) => {
        seeded = bodies;
        return [];
      }),
    });

    await usecase.execute({ principal: bob, sessionId: sourceSession.id });

    const forkedItems: Item[] = seeded.map((body, i) => ({
      ...body,
      sessionId: 's-fork-pre',
      seq: i + 1,
      createdAt: t,
    }));
    const states = insertStatesOf(forkedItems);
    const insertedItem = forkedItems.find(
      item => item.kind === 'user_message' && item.delivery === 'inserted',
    );
    expect(insertedItem).toBeDefined();
    expect(states.get(insertedItem!.seq)).toBe('unread');
  });
});

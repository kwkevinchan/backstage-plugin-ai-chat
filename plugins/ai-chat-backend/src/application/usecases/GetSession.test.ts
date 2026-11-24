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

import type { Item, ItemBody } from '@kwkevinchan/ai-chat-harness';
import { OwnerOrShareAccessControl } from '../OwnerOrShareAccessControl';
import type { AccessControl } from '../ports';
import {
  NotSessionOwner,
  type Principal,
  type Run,
  type Session,
  type Share,
} from '../../domain';
import { GetSession } from './GetSession';

const NOW = '2026-06-01T00:00:00.000Z';

const session: Session = {
  id: 's1',
  ownerRef: 'user:default/jane',
  agentId: 'default',
  enabledToolsets: [],
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function person(userRef: string, groups: string[] = []): Principal {
  return { userRef, ownershipRefs: [userRef, ...groups], credentials: {} };
}

const jane = person('user:default/jane');
const bobInGroup = person('user:default/bob', ['group:default/team']);
const bobAlone = person('user:default/bob');
const cara = person('user:default/cara');

function at(seq: number): string {
  return `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`;
}

function item(seq: number, body: ItemBody, createdAt = at(seq)): Item {
  return { sessionId: 's1', seq, runId: 'r1', createdAt, ...body };
}

function share(partial: Partial<Share> & Pick<Share, 'subjectRef'>): Share {
  return {
    id: partial.id ?? 'sh1',
    sessionId: 's1',
    createdBy: 'user:default/jane',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const waiting = { id: 'r1', status: 'waiting_approval' } as Run;
const running = { id: 'r1', status: 'running' } as Run;

function readSession(options: {
  items?: Item[];
  shares?: Share[];
  principal?: Principal;
  run?: Run;
  queue?: { id: string }[];
  access?: AccessControl;
  afterSeq?: number;
  now?: string;
}) {
  const reads: Array<unknown> = [];
  const useCase = new GetSession({
    sessions: { get: async () => session } as never,
    runs: { findActive: async () => options.run } as never,
    items: {
      read: async (_id: string, opts?: { afterSeq?: number }) => {
        reads.push(opts);
        const all = options.items ?? [];
        if (opts?.afterSeq === undefined) return all;
        return all.filter(row => row.seq > opts.afterSeq!);
      },
    } as never,
    queue: { list: async () => options.queue ?? [] } as never,
    shares: {
      listBySession: async () => options.shares ?? [],
    } as never,
    access: options.access ?? new OwnerOrShareAccessControl(),
    clock: { now: () => new Date(options.now ?? NOW) },
  });
  return {
    reads,
    result: useCase.execute({
      principal: options.principal ?? jane,
      sessionId: 's1',
      afterSeq: options.afterSeq,
    }),
  };
}

describe('GetSession', () => {
  const secret = item(2, {
    kind: 'tool_result',
    callId: 'c2',
    status: 'ok',
    output: { secret: true },
    message: 'full',
  });
  const log = [
    item(1, { kind: 'note', text: 'a' }),
    secret,
    item(3, { kind: 'note', text: 'c' }),
  ];

  it('an owner sees the same items when the session has a share', async () => {
    const { result } = readSession({
      items: log,
      shares: [share({ subjectRef: 'user:default/bob', outputsUpToSeq: 0 })],
      queue: [{ id: 'q1' }],
      run: waiting,
    });
    const view = await result;
    expect(view.items).toEqual(log);
    expect(view.queue).toEqual({ items: [{ id: 'q1' }], paused: false });
    expect(view.run).toBe(waiting);
  });

  it('a snapshot share returns only the items within up_to_seq', async () => {
    const { result } = readSession({
      principal: bobAlone,
      items: log,
      shares: [share({ subjectRef: 'user:default/bob', upToSeq: 2 })],
    });
    const view = await result;
    expect(view.items.map(row => row.seq)).toEqual([1, 2]);
    expect(view.items[1]).toMatchObject({ output: { secret: true } });
  });

  it('a live share returns every item and redacts tool output past the bound', async () => {
    const { result } = readSession({
      principal: bobAlone,
      items: log,
      shares: [share({ subjectRef: 'user:default/bob', outputsUpToSeq: 1 })],
    });
    const view = await result;
    expect(view.items.map(row => row.seq)).toEqual([1, 2, 3]);
    expect(view.items[1]).toMatchObject({
      status: 'ok',
      output: 'not shared',
    });
    expect(view.items[1]).not.toHaveProperty('message');
  });

  it.each([
    ['no share', cara, [] as Share[]],
    [
      'a revoked share',
      bobInGroup,
      [
        share({
          subjectRef: 'group:default/team',
          revokedAt: '2026-03-01T00:00:00.000Z',
        }),
      ],
    ],
    [
      'someone who is not in the group',
      cara,
      [share({ subjectRef: 'group:default/team' })],
    ],
    [
      'someone who left the group',
      bobAlone,
      [share({ subjectRef: 'group:default/team' })],
    ],
  ])('%s is NotSessionOwner', async (_name, principal, shares) => {
    const { result } = readSession({ principal, shares, items: log });
    await expect(result).rejects.toBeInstanceOf(NotSessionOwner);
  });

  it('a sharee sees the active run, an empty queue, no decision and resumable false', async () => {
    const call = item(1, {
      kind: 'tool_call',
      callId: 'c1',
      toolId: 'demo:change',
      input: { name: 'x' },
      schemaHash: 'h',
      policy: 'ask',
      readOnly: false,
      step: 1,
      position: 0,
    });
    const owner = await readSession({
      items: [call],
      run: waiting,
      queue: [{ id: 'q1' }],
    }).result;
    expect(owner.awaitingDecision).toEqual(['c1']);
    expect(owner.resumable).toBe(false);
    expect(owner.queue.items).toHaveLength(1);

    const sharee = await readSession({
      principal: bobAlone,
      items: [call],
      shares: [share({ subjectRef: 'user:default/bob' })],
      run: waiting,
      queue: [{ id: 'q1' }],
    }).result;
    expect(sharee.run).toBe(waiting);
    expect(sharee.awaitingDecision).toEqual([]);
    expect(sharee.resumable).toBe(false);
    expect(sharee.queue).toEqual({ items: [], paused: false });

    const idleOwner = await readSession({
      items: [item(1, { kind: 'note', text: 'a' })],
      run: waiting,
    }).result;
    expect(idleOwner.resumable).toBe(true);
    const idleSharee = await readSession({
      principal: bobAlone,
      items: [item(1, { kind: 'note', text: 'a' })],
      shares: [share({ subjectRef: 'user:default/bob' })],
      run: waiting,
    }).result;
    expect(idleSharee.resumable).toBe(false);
  });

  it('a sharee does not use hidden items to decide whether an inserted message was read', async () => {
    const inserted = item(1, {
      kind: 'user_message',
      text: 'while it ran',
      delivery: 'inserted',
    });
    const answer = item(2, {
      kind: 'agent_message',
      text: 'done',
      readUpToSeq: 1,
    });
    const owner = await readSession({ items: [inserted, answer] }).result;
    expect(owner.insertStates.get(1)).toBe('read');

    const { reads, result } = readSession({
      principal: bobAlone,
      items: [inserted, answer],
      shares: [share({ subjectRef: 'user:default/bob', upToSeq: 1 })],
    });
    const view = await result;
    expect(view.items.map(row => row.seq)).toEqual([1]);
    expect(view.insertStates.get(1)).toBe('unread');
    expect(reads).toEqual([undefined]);
  });

  it('an expired share still reads, frozen at expiry', async () => {
    const expiry = '2026-01-01T00:00:02.000Z';
    const items = [
      item(1, { kind: 'note', text: 'a' }, '2026-01-01T00:00:01.000Z'),
      item(2, { kind: 'note', text: 'b' }, expiry),
      item(3, { kind: 'note', text: 'c' }, '2026-01-01T00:00:03.000Z'),
    ];
    const view = await readSession({
      principal: bobAlone,
      items,
      now: '2026-02-01T00:00:00.000Z',
      shares: [share({ subjectRef: 'user:default/bob', expiresAt: expiry })],
    }).result;
    expect(view.items.map(row => row.seq)).toEqual([1, 2]);
  });

  it('a direct share still reads after the person left the group', async () => {
    const view = await readSession({
      principal: bobAlone,
      items: [item(1, { kind: 'note', text: 'a' })],
      shares: [share({ subjectRef: 'user:default/bob' })],
    }).result;
    expect(view.items).toHaveLength(1);
  });

  it('access without a granting share shows nothing', async () => {
    const access: AccessControl = {
      canReadSession: async () => true,
    };
    const view = await readSession({
      principal: cara,
      items: log,
      shares: [],
      access,
      run: running,
    }).result;
    expect(view.items).toEqual([]);
    expect(view.run).toBe(running);
    expect(view.queue).toEqual({ items: [], paused: false });
    expect(view.awaitingDecision).toEqual([]);
    expect(view.resumable).toBe(false);
  });
});

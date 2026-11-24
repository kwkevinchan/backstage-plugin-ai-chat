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
import type { Share } from './share';
import { NOT_SHARED_OUTPUT, effectiveShare, visibleItems } from './visibility';

const NOW = '2026-06-01T00:00:00.000Z';

function at(seq: number): string {
  return `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`;
}

function item(seq: number, body: ItemBody, createdAt = at(seq)): Item {
  return { sessionId: 's1', seq, runId: 'r1', createdAt, ...body };
}

function share(partial: Partial<Share> = {}): Share {
  return {
    id: 'sh1',
    sessionId: 's1',
    subjectRef: 'user:default/bob',
    createdBy: 'user:default/jane',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const note = (seq: number, text = `n${seq}`) =>
  item(seq, { kind: 'note', text });

const result = (
  seq: number,
  output: unknown,
  extra: {
    message?: string;
    truncated?: boolean;
    status?: 'ok' | 'error';
  } = {},
) =>
  item(seq, {
    kind: 'tool_result',
    callId: `c${seq}`,
    status: extra.status ?? 'ok',
    output: output as never,
    ...(extra.message !== undefined ? { message: extra.message } : {}),
    ...(extra.truncated ? { truncated: true } : {}),
  });

function see(items: Item[], one: Share, now = NOW): Item[] {
  return visibleItems(items, { isOwner: false, share: one }, now);
}

describe('visibleItems', () => {
  it('an owner sees every item and every tool output', () => {
    const items = [
      note(1),
      result(2, { secret: true }, { message: 'full', truncated: true }),
    ];
    expect(visibleItems(items, { isOwner: true }, NOW)).toEqual(items);
  });

  it('a snapshot omits items after up_to_seq and keeps the item at up_to_seq', () => {
    const items = [note(1), note(2), note(3)];
    expect(see(items, share({ upToSeq: 2 })).map(row => row.seq)).toEqual([
      1, 2,
    ]);
  });

  it('a live share that has not expired includes every item', () => {
    const items = [note(1), note(2), note(3)];
    const live = share({
      expiresAt: '2026-12-01T00:00:00.000Z',
      outputsUpToSeq: 3,
    });
    expect(see(items, live).map(row => row.seq)).toEqual([1, 2, 3]);
  });

  it('a tool result past outputs_up_to_seq keeps its status and replaces the output with "not shared"', () => {
    const hidden = result(
      2,
      { secret: true },
      {
        message: 'the tool said this',
        truncated: true,
        status: 'error',
      },
    );
    const [seen] = see([hidden], share({ upToSeq: 2, outputsUpToSeq: 1 }));
    expect(seen).toEqual({
      sessionId: 's1',
      seq: 2,
      runId: 'r1',
      createdAt: at(2),
      kind: 'tool_result',
      callId: 'c2',
      status: 'error',
      output: NOT_SHARED_OUTPUT,
    });
    expect(seen).not.toHaveProperty('message');
    expect(seen).not.toHaveProperty('truncated');
    expect(NOT_SHARED_OUTPUT).toBe('not shared');
  });

  it('a tool call keeps its id and input when the output bound is behind it', () => {
    const call = item(2, {
      kind: 'tool_call',
      callId: 'c2',
      toolId: 'demo:change',
      input: { name: 'secret' },
      schemaHash: 'h',
      policy: 'ask',
      readOnly: false,
      step: 1,
      position: 0,
    });
    expect(see([call], share({ upToSeq: 2, outputsUpToSeq: 1 }))).toEqual([
      call,
    ]);
  });

  it('a null outputs_up_to_seq keeps every tool output in range', () => {
    const items = [result(1, 'one'), result(2, 'two')];
    expect(see(items, share({ upToSeq: 2 }))).toEqual(items);
  });

  it('outputs_up_to_seq 0 leaves every tool result in range as status only', () => {
    const items = [result(1, 'one', { message: 'm' }), note(2)];
    const seen = see(items, share({ upToSeq: 2, outputsUpToSeq: 0 }));
    expect(seen[0]).toMatchObject({
      kind: 'tool_result',
      status: 'ok',
      output: 'not shared',
    });
    expect(seen[0]).not.toHaveProperty('message');
    expect(seen[1]).toEqual(items[1]);
  });

  it('a tool result at the bound keeps its output and the next one says not shared', () => {
    const items = [result(2, 'kept'), result(3, 'hidden')];
    const seen = see(items, share({ upToSeq: 3, outputsUpToSeq: 2 }));
    expect(seen[0]).toMatchObject({ seq: 2, output: 'kept' });
    expect(seen[1]).toMatchObject({ seq: 3, output: 'not shared' });
  });

  it('a summary is omitted when its seq or coversUpToSeq is past the output bound', () => {
    const bySeq = item(3, { kind: 'summary', coversUpToSeq: 1, text: 'later' });
    const byCover = item(2, {
      kind: 'summary',
      coversUpToSeq: 4,
      text: 'covers a tool output',
    });
    const kept = item(2, { kind: 'summary', coversUpToSeq: 2, text: 'ok' });
    expect(see([bySeq], share({ upToSeq: 5, outputsUpToSeq: 2 }))).toEqual([]);
    expect(see([byCover], share({ upToSeq: 5, outputsUpToSeq: 2 }))).toEqual(
      [],
    );
    expect(see([kept], share({ upToSeq: 5, outputsUpToSeq: 2 }))).toEqual([
      kept,
    ]);
  });

  it('a null output bound keeps summaries in range, and 0 omits every summary', () => {
    const summary = item(1, { kind: 'summary', coversUpToSeq: 1, text: 's' });
    expect(see([summary], share({ upToSeq: 2 }))).toEqual([summary]);
    expect(see([summary], share({ upToSeq: 2, outputsUpToSeq: 0 }))).toEqual(
      [],
    );
  });

  it('user_message, agent_message, approval, tool_started, plan_update and note stay whole inside the seq range', () => {
    const items: Item[] = [
      item(1, {
        kind: 'user_message',
        text: 'hi',
        page: { path: '/catalog' },
        delivery: 'direct',
        attachments: [
          { id: 'a1', mediaType: 'image/png', name: 'a.png', size: 3 },
        ],
      }),
      item(2, { kind: 'agent_message', text: 'ok', readUpToSeq: 1 }),
      item(3, {
        kind: 'approval',
        callId: 'c1',
        decision: 'allow',
        decidedBy: 'user:default/jane',
      }),
      item(4, { kind: 'tool_started', callId: 'c1' }),
      item(5, {
        kind: 'plan_update',
        plan: { items: [{ text: 'look', status: 'pending' }] },
      }),
      item(6, { kind: 'note', text: 'aside' }),
      note(7),
    ];
    expect(see(items, share({ upToSeq: 6, outputsUpToSeq: 0 }))).toEqual(
      items.slice(0, 6),
    );
  });

  it('after expires_at the share freezes at the last item created at or before that time', () => {
    const expiry = '2026-01-02T00:00:00.000Z';
    const items = [
      item(1, { kind: 'note', text: 'a' }, '2026-01-01T00:00:00.000Z'),
      item(2, { kind: 'note', text: 'b' }, expiry),
      item(3, { kind: 'note', text: 'c' }, '2026-01-03T00:00:00.000Z'),
    ];
    const frozen = see(
      items,
      share({ expiresAt: expiry }),
      '2026-01-02T00:00:00.001Z',
    );
    expect(frozen.map(row => row.seq)).toEqual([1, 2]);
  });

  it('an instant equal to expires_at is not expired yet', () => {
    const expiry = '2026-01-02T00:00:00.000Z';
    const items = [
      item(1, { kind: 'note', text: 'a' }, '2026-01-01T00:00:00.000Z'),
      item(2, { kind: 'note', text: 'b' }, '2026-01-03T00:00:00.000Z'),
    ];
    expect(
      see(items, share({ expiresAt: expiry }), expiry).map(row => row.seq),
    ).toEqual([1, 2]);
  });

  it('a snapshot that has also expired uses the smaller seq cap', () => {
    const expiry = '2026-01-02T00:00:00.000Z';
    const later = '2026-01-02T00:00:00.001Z';
    const items = [
      item(1, { kind: 'note', text: 'a' }, '2026-01-01T00:00:00.000Z'),
      item(2, { kind: 'note', text: 'b' }, expiry),
      item(3, { kind: 'note', text: 'c' }, '2026-01-03T00:00:00.000Z'),
      item(4, { kind: 'note', text: 'd' }, '2026-01-04T00:00:00.000Z'),
    ];
    expect(
      see(items, share({ upToSeq: 4, expiresAt: expiry }), later).map(
        row => row.seq,
      ),
    ).toEqual([1, 2]);
    expect(
      see(items, share({ upToSeq: 1, expiresAt: expiry }), later).map(
        row => row.seq,
      ),
    ).toEqual([1]);
  });

  it('tool outputs still use outputs_up_to_seq after expiry', () => {
    const expiry = '2026-01-02T00:00:00.000Z';
    const items = [
      result(1, 'kept'),
      item(
        2,
        {
          kind: 'tool_result',
          callId: 'c2',
          status: 'ok',
          output: 'hidden',
        },
        expiry,
      ),
    ];
    items[0] = item(
      1,
      { kind: 'tool_result', callId: 'c1', status: 'ok', output: 'kept' },
      '2026-01-01T00:00:00.000Z',
    );
    const seen = see(
      items,
      share({ expiresAt: expiry, outputsUpToSeq: 1 }),
      '2026-01-03T00:00:00.000Z',
    );
    expect(seen.map(row => row.seq)).toEqual([1, 2]);
    expect(seen[0]).toMatchObject({ output: 'kept' });
    expect(seen[1]).toMatchObject({ output: 'not shared' });
  });

  it('a share with no expires_at is never frozen by time', () => {
    const items = [note(1), note(2)];
    expect(see(items, share(), '2099-01-01T00:00:00.000Z')).toEqual(items);
  });

  it('does not change the items it was given', () => {
    const hidden = result(
      2,
      { secret: true },
      { message: 'full', truncated: true },
    );
    const items = [hidden];
    const before = JSON.stringify(items);
    const seen = see(items, share({ upToSeq: 2, outputsUpToSeq: 1 }));
    expect(JSON.stringify(items)).toBe(before);
    expect(seen[0]).not.toBe(items[0]);
    const owned = [note(1)];
    const ownedSeen = visibleItems(owned, { isOwner: true }, NOW);
    (ownedSeen[0] as { text: string }).text = 'changed';
    expect(owned[0]).toMatchObject({ text: 'n1' });
  });

  it('several active shares are the union of their ranges', () => {
    const items = [
      result(1, 'one'),
      result(2, 'two'),
      result(3, 'three'),
      note(4),
    ];
    const narrow = share({
      id: 'a',
      upToSeq: 2,
      outputsUpToSeq: 1,
    });
    const wider = share({ id: 'b', upToSeq: 3 });
    const revoked = share({
      id: 'c',
      upToSeq: 4,
      revokedAt: '2026-03-01T00:00:00.000Z',
    });
    const combined = effectiveShare([narrow, revoked, wider], items, NOW);
    expect(combined).toMatchObject({ upToSeq: 3 });
    expect(combined).not.toHaveProperty('outputsUpToSeq');
    expect(combined).not.toHaveProperty('expiresAt');
    expect(combined).not.toHaveProperty('revokedAt');
    const seen = visibleItems(items, { isOwner: false, share: combined! }, NOW);
    expect(seen.map(row => row.seq)).toEqual([1, 2, 3]);
    expect(seen[2]).toMatchObject({ output: 'three' });

    const live = share({ id: 'd', outputsUpToSeq: 1 });
    const withLive = effectiveShare([narrow, live], items, NOW);
    expect(withLive).not.toHaveProperty('upToSeq');
    expect(withLive).toMatchObject({ outputsUpToSeq: 1 });
    expect(
      visibleItems(items, { isOwner: false, share: withLive! }, NOW).map(
        row => row.seq,
      ),
    ).toEqual([1, 2, 3, 4]);

    expect(effectiveShare([revoked], items, NOW)).toBeUndefined();
  });

  it('an expiry freezes the union and does not drop the read by itself', () => {
    const expiry = '2026-01-01T00:00:02.000Z';
    const items = [note(1), note(2), note(3)];
    const expiredLive = share({
      id: 'a',
      expiresAt: expiry,
      outputsUpToSeq: 1,
    });
    const combined = effectiveShare(
      [expiredLive],
      items,
      '2026-02-01T00:00:00.000Z',
    );
    expect(combined).toMatchObject({ upToSeq: 2, outputsUpToSeq: 1 });
    expect(combined).not.toHaveProperty('expiresAt');
  });
});

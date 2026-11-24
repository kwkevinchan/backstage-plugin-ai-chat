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

import { insertStatesOf, unreadInserted } from './inputs';
import {
  agentSays,
  call,
  inRun,
  inserted,
  log,
  note,
  result,
  summary,
  user,
} from './fixtures';

const seqs = (items: { seq: number }[]) => items.map(item => item.seq);

describe('unreadInserted', () => {
  it('is empty when nothing was inserted', () => {
    expect(unreadInserted(log(user(), agentSays('a', 1)))).toEqual([]);
  });

  it('is empty for an empty log', () => {
    expect(unreadInserted([])).toEqual([]);
  });

  it('gives a message that is newer than every mark of the model output', () => {
    // 1 first message, 2 answer that read up to 1, 3 inserted meanwhile
    const items = log(user(), agentSays('a', 1), inserted());
    expect(seqs(unreadInserted(items))).toEqual([3]);
  });

  it('does not give a message the output has read up to', () => {
    // 2 inserted, 3 answer that read up to 2
    const items = log(user(), inserted(), agentSays('a', 2));
    expect(unreadInserted(items)).toEqual([]);
  });

  it('counts the mark of a tool_call as the mark of an agent_message', () => {
    const items = log(
      user(),
      call('c1', { readUpToSeq: 1 }),
      inserted(),
      result('c1'),
    );
    expect(seqs(unreadInserted(items))).toEqual([3]);
    const read = log(user(), inserted(), call('c1', { readUpToSeq: 2 }));
    expect(unreadInserted(read)).toEqual([]);
  });

  it('uses the largest mark of the run, not the last one', () => {
    const items = log(
      user(),
      inserted('x'),
      agentSays('a', 2),
      inserted('y'),
      call('c1', { readUpToSeq: 4 }),
      inserted('z'),
    );
    expect(seqs(unreadInserted(items))).toEqual([6]);
  });

  it('counts an output with no mark (P1) as read up to its own seq', () => {
    const items = log(user(), agentSays('a'), inserted());
    expect(seqs(unreadInserted(items))).toEqual([3]);
    const after = log(user(), inserted(), agentSays('a'));
    expect(unreadInserted(after)).toEqual([]);
  });

  it('looks at the last run only', () => {
    // The first run ended with 2 unread; the second run is not held up by it.
    const items = log(
      user('one'),
      agentSays('a', 1),
      inserted('lost'),
      user('two'),
      agentSays('b', 4),
    );
    expect(unreadInserted(items)).toEqual([]);
  });

  it('takes the last message that is not inserted as the start of the run', () => {
    const items = log(
      user('one'),
      agentSays('a', 1),
      {
        kind: 'user_message',
        text: 'queued',
        delivery: 'queued',
      },
      agentSays('b', 3),
      inserted(),
    );
    expect(seqs(unreadInserted(items))).toEqual([5]);
  });

  it('ignores items that are not output of the model', () => {
    const items = log(user(), inserted(), note(), summary(0));
    expect(seqs(unreadInserted(items))).toEqual([2]);
  });

  it('does not use the run id to find the run', () => {
    const items = log(
      ...inRun('run-9', user()),
      ...inRun('run-9', agentSays('a', 1)),
      ...inRun('run-9', inserted()),
    );
    expect(seqs(unreadInserted(items))).toEqual([3]);
  });
});

describe('insertStatesOf', () => {
  it('is empty when nothing was inserted', () => {
    expect(insertStatesOf(log(user(), agentSays())).size).toBe(0);
  });

  it('says read or unread for each inserted message by its seq', () => {
    const items = log(user(), inserted('x'), agentSays('a', 2), inserted('y'));
    expect([...insertStatesOf(items)]).toEqual([
      [2, 'read'],
      [4, 'unread'],
    ]);
  });

  it('works out each run on its own', () => {
    const items = log(
      user('one'),
      agentSays('a', 1),
      inserted('lost'),
      user('two'),
      inserted('read'),
      agentSays('b', 5),
    );
    expect([...insertStatesOf(items)]).toEqual([
      [3, 'unread'],
      [5, 'read'],
    ]);
  });

  it('does not let the mark of a later run read a message of an earlier one', () => {
    const items = log(
      user('one'),
      inserted('lost'),
      user('two'),
      agentSays('b', 99),
    );
    expect(insertStatesOf(items).get(2)).toBe('unread');
  });
});

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

import type { Item } from './item';

/** Whether the model has read an inserted message (IN-12). @public */
export type ReadState = 'read' | 'unread';

type Range = {
  /** The inserted messages of the run, in the order of `seq`. */
  inserted: Item[];
  /** The largest `readUpToSeq` of the model output of the run, or 0. */
  readUpTo: number;
};

function isInserted(item: Item): boolean {
  return item.kind === 'user_message' && item.delivery === 'inserted';
}

/**
 * Cuts the log into runs by the messages that are not inserted: each such
 * message is the first message of a run (so the cut needs no `runId`), and the
 * messages inserted after it belong to the same run.
 */
function rangesOf(items: readonly Item[]): Range[] {
  const ranges: Range[] = [{ inserted: [], readUpTo: 0 }];
  for (const item of items) {
    const range = ranges[ranges.length - 1];
    if (item.kind === 'user_message') {
      if (isInserted(item)) range.inserted.push(item);
      else ranges.push({ inserted: [], readUpTo: 0 });
    } else if (item.kind === 'agent_message' || item.kind === 'tool_call') {
      // An item with no mark (P1) counts as having read up to its own seq.
      range.readUpTo = Math.max(range.readUpTo, item.readUpToSeq ?? item.seq);
    }
  }
  return ranges;
}

/**
 * The inserted messages of the last run that the model has not read yet: the
 * ones with a `seq` above every `readUpToSeq` of the model output since the
 * first message of the run. Only the last run counts, so the unread messages of
 * a run that has ended do not keep the next run from ending (IN-11).
 *
 * @public
 */
export function unreadInserted(items: readonly Item[]): Item[] {
  const last = rangesOf(items).pop();
  if (!last) return [];
  return last.inserted.filter(item => item.seq > last.readUpTo);
}

/**
 * Whether the model read each inserted message of the log, by its `seq`. Each
 * run is worked out on its own. A message of a run that has ended and is
 * `unread` is one the user is told the agent did not read (IN-12).
 *
 * @public
 */
export function insertStatesOf(
  items: readonly Item[],
): ReadonlyMap<number, ReadState> {
  const states = new Map<number, ReadState>();
  for (const range of rangesOf(items)) {
    for (const item of range.inserted) {
      states.set(item.seq, item.seq > range.readUpTo ? 'unread' : 'read');
    }
  }
  return states;
}

/**
 * The log without the unread inserted messages of the runs that have ended:
 * the model never reads them, because the user can send them again as a new
 * message and the model would read them twice. The unread messages of the last
 * run stay, because the next model call is the one that reads them.
 */
export function withoutLostInserts(items: readonly Item[]): readonly Item[] {
  const states = insertStatesOf(items);
  if (states.size === 0) return items;
  const current = new Set(unreadInserted(items).map(item => item.seq));
  return items.filter(
    item =>
      !(
        isInserted(item) &&
        states.get(item.seq) === 'unread' &&
        !current.has(item.seq)
      ),
  );
}

/**
 * The log in the order the model should read it: each inserted message goes
 * before the first model output that read it (`readUpToSeq` at least its
 * `seq`), so after every output that did not read it and after the tool
 * results of those steps. A message no output has read goes to the end of its
 * run. An output with no mark (P1) counts as having read up to its own `seq`,
 * so a log of P1 keeps the order of `seq`. Only the position changes; `seq`
 * does not, so a summary still covers by `seq` and never reaches a message
 * inserted after the first message of the run.
 */
export function inCausalOrder(items: readonly Item[]): readonly Item[] {
  if (!items.some(isInserted)) return items;
  const ordered: Item[] = [];
  let run: Item[] = [];
  for (const item of items) {
    if (item.kind === 'user_message' && !isInserted(item)) {
      ordered.push(...placeInserted(run));
      run = [];
    }
    run.push(item);
  }
  ordered.push(...placeInserted(run));
  return ordered;
}

function placeInserted(run: Item[]): Item[] {
  const inserted = run.filter(isInserted);
  if (inserted.length === 0) return run;
  const before = new Map<number, Item[]>();
  const unread: Item[] = [];
  for (const message of inserted) {
    const at = run.findIndex(
      item =>
        (item.kind === 'agent_message' || item.kind === 'tool_call') &&
        (item.readUpToSeq ?? item.seq) >= message.seq,
    );
    if (at < 0) unread.push(message);
    else before.set(at, [...(before.get(at) ?? []), message]);
  }
  const placed = new Set(inserted);
  const ordered: Item[] = [];
  run.forEach((item, index) => {
    ordered.push(...(before.get(index) ?? []));
    if (!placed.has(item)) ordered.push(item);
  });
  return [...ordered, ...unread];
}

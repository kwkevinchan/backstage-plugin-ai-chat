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
  DuplicateItem,
  LeaseLost,
  dedupeKeyOf,
  type Clock,
  type Item,
  type ItemDraft,
  type ItemLog,
  type RunFence,
} from '@kwkevinchan/ai-chat-harness';

/**
 * An `ItemLog` in memory. It follows the same rules as a database log (see
 * `itemLogContract`): sequence numbers from 1, no gaps, a write is all or
 * nothing, a key of `dedupeKeyOf` is written once per session, and only the
 * holder of the lease of a run may write.
 *
 * Nobody holds a lease at first. A test grants it with `grantLease`; granting
 * the same run to another owner takes it away from the first. Like the lease
 * of a database log it covers every kind of item, which is stricter than the
 * log of the host: that one checks the status of the run for the messages and
 * approvals the host writes.
 *
 * @public
 */
export class InMemoryItemLog implements ItemLog {
  private readonly sessions = new Map<string, Item[]>();
  private readonly leases = new Map<
    string,
    { sessionId: string; leaseOwner: string }
  >();
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? { now: () => new Date() };
  }

  /**
   * Makes `fence.leaseOwner` the holder of the lease of `fence.runId`, a run of
   * this session. A run belongs to one session: a fence of another session's
   * run is refused.
   */
  grantLease(sessionId: string, fence: RunFence): void {
    this.leases.set(fence.runId, { sessionId, leaseOwner: fence.leaseOwner });
  }

  async read(
    sessionId: string,
    opts: { afterSeq?: number; fromLatestSummary?: boolean } = {},
  ): Promise<Item[]> {
    const items = this.sessions.get(sessionId) ?? [];
    let afterSeq = opts.afterSeq ?? 0;
    if (opts.fromLatestSummary) {
      const newest = [...items].reverse().find(item => item.kind === 'summary');
      if (newest?.kind === 'summary') {
        afterSeq = Math.max(afterSeq, newest.coversUpToSeq);
      }
    }
    return items
      .filter(item => item.seq > afterSeq)
      .map(item => structuredClone(item));
  }

  async append(
    sessionId: string,
    drafts: ItemDraft[],
    fence: RunFence,
  ): Promise<Item[]> {
    const lease = this.leases.get(fence.runId);
    if (
      lease?.sessionId !== sessionId ||
      lease.leaseOwner !== fence.leaseOwner
    ) {
      throw new LeaseLost(fence.runId);
    }
    const existing = this.sessions.get(sessionId) ?? [];
    const keys = new Set(
      existing.map(item => dedupeKeyOf(item)).filter(isDefined),
    );
    for (const draft of drafts) {
      const key = dedupeKeyOf(draft);
      if (key === undefined) continue;
      if (keys.has(key)) throw new DuplicateItem(key);
      keys.add(key);
    }

    const createdAt = this.clock.now().toISOString();
    const written = drafts.map(
      (draft, index) =>
        ({
          ...structuredClone(draft),
          sessionId,
          seq: existing.length + index + 1,
          runId: fence.runId,
          createdAt,
        } as Item),
    );
    this.sessions.set(sessionId, [...existing, ...written]);
    return written.map(item => structuredClone(item));
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

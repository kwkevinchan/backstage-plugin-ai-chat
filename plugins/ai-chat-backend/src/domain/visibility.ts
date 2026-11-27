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

import type { Item, ToolResultBody } from '@kwkevinchan/ai-chat-harness';
import type { Share } from './share';

/**
 * The output text of a tool result the share does not include. English, like
 * the other text the host stores in place of content (`tool call limit`).
 */
export const NOT_SHARED_OUTPUT = 'not shared';

/**
 * An item as one viewer may see it. A tool result past the output bound is
 * still an item: it keeps its status and its output is {@link NOT_SHARED_OUTPUT}.
 */
export type VisibleItem = Item;

/**
 * The greatest seq a share shows at `now`, or absent when the share shows
 * every item. Past `expiresAt` (a later `now`; the same instant is not past
 * it) the share freezes at the last item whose `createdAt` is at or before
 * `expiresAt`. A share that also has `upToSeq` uses the smaller of the two,
 * so expiry cannot reveal items the snapshot never included. No item at or
 * before the expiry freezes at seq 0, which shows nothing.
 */
export function visibleSeqLimit(
  share: Share,
  items: readonly Item[],
  now: string,
): number | undefined {
  if (share.expiresAt === undefined || now <= share.expiresAt) {
    return share.upToSeq;
  }
  let frozen = 0;
  for (const item of items) {
    if (item.createdAt <= share.expiresAt && item.seq > frozen) {
      frozen = item.seq;
    }
  }
  if (share.upToSeq === undefined) return frozen;
  return Math.min(share.upToSeq, frozen);
}

/**
 * One share that shows the union of several. A revoked share is left out. Any
 * share that is not frozen and has no `upToSeq` shows every item; otherwise
 * the seq cap is the greatest of the caps. Each share's output bound is first
 * capped by that share's own seq limit (an absent `outputsUpToSeq` means
 * every tool output and summary up to that limit, not every output in the
 * log). The union then takes the greatest of those bounds. The result omits
 * `outputsUpToSeq` only when that greatest bound is unbounded. The result
 * has no `expiresAt`: the freeze is already in `upToSeq`, so
 * {@link visibleItems} does not freeze it a second time.
 */
export function effectiveShare(
  shares: readonly Share[],
  items: readonly Item[],
  now: string,
): Share | undefined {
  const active = shares.filter(share => share.revokedAt === undefined);
  if (active.length === 0) return undefined;
  const limits = active.map(share => visibleSeqLimit(share, items, now));
  const numbers = limits.filter(
    (limit): limit is number => limit !== undefined,
  );
  const upToSeq =
    numbers.length === limits.length ? Math.max(...numbers) : undefined;
  const bounds = active.map((share, index) => {
    const output =
      share.outputsUpToSeq === undefined
        ? Number.POSITIVE_INFINITY
        : share.outputsUpToSeq;
    const limit =
      limits[index] === undefined ? Number.POSITIVE_INFINITY : limits[index];
    return Math.min(output, limit);
  });
  const widest = Math.max(...bounds);
  const outputsUpToSeq = Number.isFinite(widest) ? widest : undefined;
  const first = active[0];
  return {
    id: first.id,
    sessionId: first.sessionId,
    subjectRef: first.subjectRef,
    createdBy: first.createdBy,
    createdAt: first.createdAt,
    ...(upToSeq !== undefined ? { upToSeq } : {}),
    ...(outputsUpToSeq !== undefined ? { outputsUpToSeq } : {}),
  };
}

/**
 * The items `viewer` may see at `now` (SH-08, SH-09, SH-11). The owner sees
 * every item. Anyone else sees the items of `share`: seq at most the limit
 * from {@link visibleSeqLimit}, tool results past `outputsUpToSeq` reduced to
 * a status, and summaries past that bound left out whole. The input is not
 * changed.
 */
export function visibleItems(
  items: readonly Item[],
  viewer: { isOwner: true } | { isOwner: false; share: Share },
  now: string,
): VisibleItem[] {
  if (viewer.isOwner) return items.map(item => ({ ...item }));
  const limit = visibleSeqLimit(viewer.share, items, now);
  const outputLimit = viewer.share.outputsUpToSeq;
  const visible: VisibleItem[] = [];
  for (const item of items) {
    if (limit !== undefined && item.seq > limit) continue;
    if (item.kind === 'summary') {
      if (
        outputLimit !== undefined &&
        (item.seq > outputLimit || item.coversUpToSeq > outputLimit)
      ) {
        continue;
      }
      visible.push({ ...item });
      continue;
    }
    if (
      item.kind === 'tool_result' &&
      outputLimit !== undefined &&
      item.seq > outputLimit
    ) {
      visible.push(redactedResult(item));
      continue;
    }
    visible.push({ ...item });
  }
  return visible;
}

/** Status and fixed denial code only. `message` and `truncated` would carry the output too. */
function redactedResult(item: Item & ToolResultBody): Item {
  return {
    sessionId: item.sessionId,
    seq: item.seq,
    ...(item.runId !== undefined ? { runId: item.runId } : {}),
    createdAt: item.createdAt,
    kind: 'tool_result',
    callId: item.callId,
    status: item.status,
    ...(item.deniedReason !== undefined
      ? { deniedReason: item.deniedReason }
      : {}),
    output: NOT_SHARED_OUTPUT,
  };
}

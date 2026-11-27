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

import type { ItemLog } from '@kwkevinchan/ai-chat-harness';
import type { Principal, Session } from '../../domain';
import type { RunRepository, SessionRepository } from '../ports';

const MAX_PREVIEW_TITLE_CHARS = 60;

/**
 * A session in the list. `activity` is set when a run of it has not ended.
 * It comes from that run, not from a column of its own. `previewTitle` is
 * the truncated opening of the first user message while `title` is still unset.
 */
export type ListedSession = Session & {
  activity?: 'running' | 'waiting_approval';
  previewTitle?: string;
};

function previewOf(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_PREVIEW_TITLE_CHARS
    ? `${collapsed.slice(0, MAX_PREVIEW_TITLE_CHARS).trimEnd()}…`
    : collapsed;
}

/**
 * The sessions of the signed-in user. Pinned ones come first, then the most
 * recently updated. `query` matches the title (SE-03). `entityRef` keeps the
 * sessions bound to that entity (SE-06), a ref normalized by the caller.
 */
export class ListSessions {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      runs: RunRepository;
      items?: Pick<ItemLog, 'read'>;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    includeArchived?: boolean;
    limit?: number;
    query?: string;
    entityRef?: string;
  }): Promise<ListedSession[]> {
    const sessions = await this.deps.sessions.listByOwner(
      input.principal.userRef,
      {
        includeArchived: input.includeArchived,
        limit: input.limit,
        query: input.query,
        ...(input.entityRef !== undefined && { entityRef: input.entityRef }),
      },
    );
    const active = await this.deps.runs.findActiveForSessions(
      sessions.map(session => session.id),
    );
    const bySession = new Map(active.map(run => [run.sessionId, run]));

    const previews = new Map<string, string>();
    if (this.deps.items) {
      const untitled = sessions.filter(s => !s.title?.trim());
      await Promise.all(
        untitled.map(async session => {
          const list = await this.deps.items!.read(session.id);
          const first = list.find(
            item => item.kind === 'user_message' && item.text.trim().length > 0,
          );
          if (first?.kind === 'user_message') {
            const preview = previewOf(first.text);
            if (preview) previews.set(session.id, preview);
          }
        }),
      );
    }

    return sessions.map(session => {
      const status = bySession.get(session.id)?.status;
      const previewTitle = previews.get(session.id);
      return {
        ...session,
        ...((status === 'running' || status === 'waiting_approval') && {
          activity: status,
        }),
        ...(previewTitle !== undefined && { previewTitle }),
      };
    });
  }
}

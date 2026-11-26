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
  AttachmentRef,
  Clock,
  IdGenerator,
  Item,
  ItemBody,
  ItemLog,
} from '@kwkevinchan/ai-chat-harness';
import {
  defaultToolsetIds,
  type Principal,
  type Session,
  type VisibleItem,
} from '../../domain';
import { readableEntityRef } from '../entityContext';
import type {
  AccessControl,
  AgentCatalog,
  AttachmentStore,
  AuditLog,
  EntityReader,
  SessionRepository,
  ShareRepository,
} from '../ports';
import { authorizeRead, shareeView } from '../sessionRead';
import { usableToolsets } from '../ToolsetScope';

/**
 * Copies a session the caller may read into a new session owned by the caller
 * (SH-04, SH-06, IN-19).
 *
 * Only `user_message`, `agent_message`, and `plan_update` items within the
 * caller's visible scope are copied. Tool calls, tool outputs, approvals,
 * summaries, notes, queued messages, and shares are never copied. Images on
 * copied `user_message` items are duplicated into the new session with new ids
 * owned by the caller.
 */
export class ForkSession {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      items: ItemLog;
      attachments: AttachmentStore;
      shares: ShareRepository;
      access: AccessControl;
      agents: AgentCatalog;
      entities: EntityReader;
      audit: AuditLog;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<Session> {
    const reader = await authorizeRead(
      this.deps,
      input.sessionId,
      input.principal,
    );
    const source = reader.session;
    const sourceItems: readonly (Item | VisibleItem)[] = reader.isOwner
      ? await this.deps.items.read(source.id)
      : (await shareeView(this.deps, source, input.principal, reader.shares))
          .visible;

    const kept = sourceItems.filter(
      (
        item,
      ): item is
        | Extract<Item, { kind: 'user_message' }>
        | Extract<Item, { kind: 'agent_message' }>
        | Extract<Item, { kind: 'plan_update' }> =>
        item.kind === 'user_message' ||
        item.kind === 'agent_message' ||
        item.kind === 'plan_update',
    );

    const usable = await usableToolsets(this.deps, input.principal);
    const usableIds = new Set(usable.map(t => t.id));
    const filteredToolsets = source.enabledToolsets.filter(id =>
      usableIds.has(id),
    );
    const enabledToolsets =
      filteredToolsets.length > 0
        ? filteredToolsets
        : defaultToolsetIds(usable);

    const entityRef =
      source.entityRef === undefined
        ? undefined
        : await readableEntityRef(
            this.deps.entities,
            source.entityRef,
            input.principal,
          );

    const sourceAttachmentIds = [
      ...new Set(
        kept.flatMap(item =>
          item.kind === 'user_message'
            ? (item.attachments ?? []).map(a => a.id)
            : [],
        ),
      ),
    ];

    // Map source sequence numbers to the new 1..N sequence numbers so inserted
    // messages preserve whether the model had read them.
    const seqMap = new Map<number, number>();
    kept.forEach((item, index) => {
      seqMap.set(item.seq, index + 1);
    });
    const remapReadUpToSeq = (
      oldSeq: number | undefined,
    ): number | undefined => {
      if (oldSeq === undefined) return undefined;
      const direct = seqMap.get(oldSeq);
      if (direct !== undefined) return direct;
      let latest: number | undefined;
      for (const [sourceSeq, mappedSeq] of seqMap.entries()) {
        if (sourceSeq <= oldSeq) latest = mappedSeq;
      }
      return latest ?? 0;
    };

    const forkedId = this.deps.ids.next();
    const span = await this.deps.audit.begin({
      eventId: 'session-fork',
      actorRef: input.principal.userRef,
      sourceSessionId: source.id,
      sessionId: forkedId,
      copiedItems: kept.length,
      copiedAttachments: sourceAttachmentIds.length,
    });

    let created = false;
    try {
      const forked = await this.deps.sessions.create({
        id: forkedId,
        ownerRef: input.principal.userRef,
        agentId: source.agentId,
        ...(source.title !== undefined && { title: source.title }),
        ...(entityRef !== undefined && { entityRef }),
        enabledToolsets,
      });
      created = true;

      const copiedAttachments =
        sourceAttachmentIds.length > 0
          ? await this.deps.attachments.copy({
              fromSessionId: source.id,
              toSessionId: forked.id,
              ownerRef: input.principal.userRef,
              ids: sourceAttachmentIds,
            })
          : new Map();

      const bodies: ItemBody[] = kept.map(item => {
        if (item.kind === 'user_message') {
          const attachments: AttachmentRef[] = [];
          for (const att of item.attachments ?? []) {
            const meta = copiedAttachments.get(att.id);
            if (meta) {
              attachments.push({
                id: meta.id,
                mediaType: meta.mediaType,
                name: meta.name,
                size: meta.size,
              });
            }
          }
          return {
            kind: 'user_message',
            text: item.text,
            ...(attachments.length > 0 && { attachments }),
            ...(item.page && { page: item.page }),
            ...(item.delivery && { delivery: item.delivery }),
          };
        }
        if (item.kind === 'agent_message') {
          const readUpToSeq = remapReadUpToSeq(item.readUpToSeq);
          return {
            kind: 'agent_message',
            text: item.text,
            ...(readUpToSeq !== undefined && { readUpToSeq }),
          };
        }
        return {
          kind: 'plan_update',
          plan: item.plan,
        };
      });

      if (bodies.length > 0) {
        await this.deps.sessions.seedItems(forked.id, bodies);
      }
      await span.success();
      return forked;
    } catch (error) {
      if (created) {
        await this.deps.sessions.delete(forkedId).catch(() => {});
      }
      await span.fail(error instanceof Error ? error.message : 'fork failed');
      throw error;
    }
  }
}

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
  CONTEXT_PROVIDER_TIMEOUT_MS,
  type MessageReference,
  type ReferencedEntity,
} from '@kwkevinchan/ai-chat-harness';
import {
  normalizeEntityRef,
  TooManyReferences,
  type EntityFacts,
  type Principal,
} from '../domain';
import type { EntityReader, Logger } from './ports';
import { withTimeout } from './withTimeout';

/** A reference as the request gives it (B-04). */
export type ReferenceInput =
  | { kind: 'entity'; entityRef: string }
  | { kind: 'text'; text: string; title?: string; url?: string };

/** `aiChat.input.references`. */
export type ReferenceSettings = { maxPerMessage: number };

function referencedEntity(facts: EntityFacts): ReferencedEntity {
  return {
    kind: facts.kind,
    namespace: facts.namespace,
    name: facts.name,
    ...(facts.title !== undefined && { title: facts.title }),
    ...(facts.description !== undefined && { description: facts.description }),
    ...(facts.type !== undefined && { type: facts.type }),
    ...(facts.lifecycle !== undefined && { lifecycle: facts.lifecycle }),
    ...(facts.owner !== undefined && { owner: facts.owner }),
    ...(facts.system !== undefined && { system: facts.system }),
    ...(facts.tags !== undefined && { tags: facts.tags }),
  };
}

/**
 * The references of a message as the log keeps them (B-04): each entity
 * read with the credentials of the user, once, before the message is
 * written, so the model input is built from what is stored (D-18). An entity
 * that does not exist, that the user cannot read, or that the catalog does
 * not give in `CONTEXT_PROVIDER_TIMEOUT_MS` is kept as `readable: false`,
 * with no details, and the message goes on. Throws `TooManyReferences`
 * when there are more than the administrator allows.
 */
export async function resolveReferences(
  deps: {
    entities: EntityReader;
    references: ReferenceSettings;
    logger?: Logger;
  },
  principal: Principal,
  inputs: ReferenceInput[] | undefined,
): Promise<MessageReference[]> {
  if (!inputs || inputs.length === 0) return [];
  const { maxPerMessage } = deps.references;
  if (inputs.length > maxPerMessage) {
    throw new TooManyReferences(maxPerMessage);
  }
  return Promise.all(
    inputs.map(async (input): Promise<MessageReference> => {
      if (input.kind === 'text') {
        return {
          kind: 'text',
          text: input.text,
          ...(input.title !== undefined && { title: input.title }),
          ...(input.url !== undefined && { url: input.url }),
        };
      }
      const entityRef = normalizeEntityRef(input.entityRef);
      if (entityRef === undefined) {
        return { kind: 'entity', entityRef: input.entityRef, readable: false };
      }
      try {
        const facts = await withTimeout(
          deps.entities.read(entityRef, principal),
          CONTEXT_PROVIDER_TIMEOUT_MS,
        );
        return facts
          ? {
              kind: 'entity',
              entityRef,
              readable: true,
              entity: referencedEntity(facts),
            }
          : { kind: 'entity', entityRef, readable: false };
      } catch (error) {
        deps.logger?.warn(
          'AI chat could not read an entity that a message refers to',
          {
            entityRef,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return { kind: 'entity', entityRef, readable: false };
      }
    }),
  );
}

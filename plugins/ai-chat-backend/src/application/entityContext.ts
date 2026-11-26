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

import type { ContextProvider } from '@kwkevinchan/ai-chat-harness';
import {
  normalizeEntityRef,
  type EntityFacts,
  type Principal,
} from '../domain';
import type { EntityReader } from './ports';

/** The ids of the built-in context providers; a module cannot take them. */
export const BUILT_IN_CONTEXT_PROVIDER_IDS: readonly string[] = [
  'user',
  'entity',
  'plan',
];

function principalOf(value: unknown): Principal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { userRef, ownershipRefs } = value as Partial<Principal>;
  if (typeof userRef !== 'string') return undefined;
  return {
    ...(value as Principal),
    ownershipRefs: Array.isArray(ownershipRefs)
      ? ownershipRefs.filter((ref): ref is string => typeof ref === 'string')
      : [],
  };
}

/**
 * The built-in context provider `user` (X-03): the entity ref of the user
 * and the other refs the user owns through. The refs are written as JSON
 * strings, as the line of the page is. No name or e-mail: nothing personal
 * goes to the model server that the refs do not say already.
 */
export function userContextProvider(): ContextProvider {
  return {
    id: 'user',
    provide(ctx) {
      const principal = principalOf(ctx.principal);
      if (!principal) return undefined;
      const others = principal.ownershipRefs.filter(
        ref => ref !== principal.userRef,
      );
      return [
        `The signed-in user is ${JSON.stringify(principal.userRef)}.`,
        ...(others.length > 0
          ? [
              `The user also owns things through: ${others
                .map(ref => JSON.stringify(ref))
                .join(', ')}.`,
            ]
          : []),
      ].join('\n');
    },
  };
}

/** The facts in a fixed order, the ones that are not set left out. */
function factsJson(facts: EntityFacts): string {
  const ordered: Partial<EntityFacts> = {
    kind: facts.kind,
    namespace: facts.namespace,
    name: facts.name,
    title: facts.title,
    description: facts.description,
    type: facts.type,
    lifecycle: facts.lifecycle,
    owner: facts.owner,
    system: facts.system,
    tags: facts.tags && facts.tags.length > 0 ? facts.tags : undefined,
  };
  return JSON.stringify(ordered, null, 2);
}

/**
 * The built-in context provider `entity` (X-03): the entity the session is
 * bound to, read again at every step with the credentials of the user, so a
 * user who lost the right to read it gets nothing of it. An entity that does
 * not exist and one the user cannot read give the same sentence.
 */
export function entityContextProvider(
  entities: EntityReader,
): ContextProvider {
  return {
    id: 'entity',
    async provide(ctx) {
      const ref = ctx.sessionEntityRef;
      const principal = principalOf(ctx.principal);
      if (ref === undefined || !principal) return undefined;
      const facts = await entities.read(ref, principal);
      if (!facts) {
        return `The session is about ${JSON.stringify(
          ref,
        )}, but its details are not available to this user.`;
      }
      return `The session is about ${JSON.stringify(ref)}.\n${factsJson(
        facts,
      )}`;
    },
  };
}

/**
 * The normalized ref of `value` when the user can read that entity
 * (SE-02), else `undefined`. Throws when the catalog cannot be reached.
 */
export async function readableEntityRef(
  entities: EntityReader,
  value: string,
  principal: Principal,
): Promise<string | undefined> {
  const ref = normalizeEntityRef(value);
  if (ref === undefined) return undefined;
  return (await entities.read(ref, principal)) ? ref : undefined;
}

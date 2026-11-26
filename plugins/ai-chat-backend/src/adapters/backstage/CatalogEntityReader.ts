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

import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { EntityReader } from '../../application/ports';
import type { EntityFacts, Principal } from '../../domain';

type Entity = NonNullable<
  Awaited<ReturnType<CatalogService['getEntityByRef']>>
>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The fields of an entity the chat uses, the others left out. */
export function factsOf(entity: Entity): EntityFacts {
  const spec = (entity.spec ?? {}) as Record<string, unknown>;
  const tags = (entity.metadata.tags ?? []).filter(
    (tag): tag is string => typeof tag === 'string',
  );
  const facts: EntityFacts = {
    kind: entity.kind,
    namespace: entity.metadata.namespace ?? 'default',
    name: entity.metadata.name,
  };
  const optional: Omit<EntityFacts, 'kind' | 'namespace' | 'name'> = {
    title: text(entity.metadata.title),
    description: text(entity.metadata.description),
    type: text(spec.type),
    lifecycle: text(spec.lifecycle),
    owner: text(spec.owner),
    system: text(spec.system),
    tags: tags.length > 0 ? tags : undefined,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (facts as Record<string, unknown>)[key] = value;
  }
  return facts;
}

/**
 * Reads entities through the catalog service with the credentials of the
 * user, so the permission policy of the catalog decides what the user reads.
 */
export class CatalogEntityReader implements EntityReader {
  constructor(private readonly catalog: Pick<CatalogService, 'getEntityByRef'>) {}

  async read(
    entityRef: string,
    principal: Principal,
  ): Promise<EntityFacts | undefined> {
    const entity = await this.catalog.getEntityByRef(entityRef, {
      credentials: principal.credentials as BackstageCredentials,
    });
    return entity ? factsOf(entity) : undefined;
  }
}

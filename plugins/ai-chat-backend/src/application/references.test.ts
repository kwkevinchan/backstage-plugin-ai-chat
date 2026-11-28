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

import { CONTEXT_PROVIDER_TIMEOUT_MS } from '@kwkevinchan/ai-chat-harness';
import { TooManyReferences, type EntityFacts, type Principal } from '../domain';
import type { EntityReader } from './ports';
import { resolveReferences } from './references';

const jane: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: { user: 'jane' },
};

const SHOP: EntityFacts = {
  kind: 'component',
  namespace: 'default',
  name: 'shop',
  title: 'Shop',
  description: 'Sells things.',
  type: 'service',
  lifecycle: 'production',
  owner: 'group:default/team-a',
  system: 'store',
  tags: ['web'],
};

/** The shop, readable by Jane; every other ref is not found. */
function catalog(read?: EntityReader['read']) {
  const reads: { entityRef: string; principal: Principal }[] = [];
  const entities: EntityReader = {
    async read(entityRef, principal) {
      reads.push({ entityRef, principal });
      if (read) return read(entityRef, principal);
      return entityRef === 'component:default/shop' ? SHOP : undefined;
    },
  };
  return { entities, reads };
}

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('resolveReferences (B-04)', () => {
  it('keeps the facts of an entity the user can read, read with the credentials of the user', async () => {
    const { entities, reads } = catalog();
    const references = await resolveReferences(
      { entities, references: { maxPerMessage: 5 } },
      jane,
      [{ kind: 'entity', entityRef: 'Component:shop' }],
    );
    expect(references).toEqual([
      {
        kind: 'entity',
        entityRef: 'component:default/shop',
        readable: true,
        entity: SHOP,
      },
    ]);
    expect(reads).toEqual([
      { entityRef: 'component:default/shop', principal: jane },
    ]);
  });

  it('marks an entity the user cannot read, or that does not exist, as not readable, with no facts', async () => {
    const { entities } = catalog();
    const references = await resolveReferences(
      { entities, references: { maxPerMessage: 5 } },
      jane,
      [{ kind: 'entity', entityRef: 'component:default/secret' }],
    );
    expect(references).toEqual([
      {
        kind: 'entity',
        entityRef: 'component:default/secret',
        readable: false,
      },
    ]);
  });

  it('marks the entities as not readable when the catalog fails or does not answer, and logs it', async () => {
    jest.useFakeTimers();
    try {
      const failing = catalog(async () => {
        throw new Error('catalog down');
      });
      const log = logger();
      expect(
        await resolveReferences(
          {
            entities: failing.entities,
            references: { maxPerMessage: 5 },
            logger: log,
          },
          jane,
          [{ kind: 'entity', entityRef: 'component:default/shop' }],
        ),
      ).toEqual([
        {
          kind: 'entity',
          entityRef: 'component:default/shop',
          readable: false,
        },
      ]);
      expect(log.warn).toHaveBeenCalledWith(
        'AI chat could not read an entity that a message refers to',
        { entityRef: 'component:default/shop', error: 'catalog down' },
      );

      const hanging = catalog(() => new Promise(() => undefined));
      const slow = logger();
      const pending = resolveReferences(
        {
          entities: hanging.entities,
          references: { maxPerMessage: 5 },
          logger: slow,
        },
        jane,
        [{ kind: 'entity', entityRef: 'component:default/shop' }],
      );
      await jest.advanceTimersByTimeAsync(CONTEXT_PROVIDER_TIMEOUT_MS);
      expect(await pending).toEqual([
        {
          kind: 'entity',
          entityRef: 'component:default/shop',
          readable: false,
        },
      ]);
      expect(slow.warn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses more references than the administrator allows', async () => {
    const { entities, reads } = catalog();
    const text = { kind: 'text' as const, text: 'a' };
    await expect(
      resolveReferences({ entities, references: { maxPerMessage: 2 } }, jane, [
        text,
        text,
        { kind: 'entity', entityRef: 'component:default/shop' },
      ]),
    ).rejects.toThrow(TooManyReferences);
    expect(reads).toEqual([]);
    expect(
      await resolveReferences(
        { entities, references: { maxPerMessage: 2 } },
        jane,
        [text, text],
      ),
    ).toHaveLength(2);
  });

  it('keeps a text reference as it was given', async () => {
    const { entities, reads } = catalog();
    expect(
      await resolveReferences(
        { entities, references: { maxPerMessage: 5 } },
        jane,
        [
          {
            kind: 'text',
            text: 'line 1\nline "2"',
            title: 'Runbook',
            url: '/docs/runbook',
          },
          { kind: 'text', text: 'bare' },
        ],
      ),
    ).toEqual([
      {
        kind: 'text',
        text: 'line 1\nline "2"',
        title: 'Runbook',
        url: '/docs/runbook',
      },
      { kind: 'text', text: 'bare' },
    ]);
    expect(reads).toEqual([]);
    expect(
      await resolveReferences(
        { entities, references: { maxPerMessage: 5 } },
        jane,
        undefined,
      ),
    ).toEqual([]);
  });
});

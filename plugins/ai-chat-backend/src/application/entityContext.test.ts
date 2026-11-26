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

import type { StepContext } from '@kwkevinchan/ai-chat-harness';
import type { EntityFacts, Principal } from '../domain';
import type { EntityReader } from './ports';
import {
  entityContextProvider,
  readableEntityRef,
  userContextProvider,
} from './entityContext';

const jane: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: { user: 'jane' },
};

/** Entities by ref, each readable by everyone or by `readers` only. */
class FakeEntityReader implements EntityReader {
  failing = false;
  readonly reads: { entityRef: string; principal: Principal }[] = [];

  constructor(
    private readonly entities: {
      ref: string;
      facts?: Partial<EntityFacts>;
      readers?: string[];
    }[] = [],
  ) {}

  async read(entityRef: string, principal: Principal) {
    this.reads.push({ entityRef, principal });
    if (this.failing) throw new Error('the catalog is down');
    const found = this.entities.find(entity => entity.ref === entityRef);
    if (
      !found ||
      (found.readers && !found.readers.includes(principal.userRef))
    ) {
      return undefined;
    }
    const [kind, rest] = entityRef.split(':');
    const [namespace, name] = rest.split('/');
    return { kind, namespace, name, ...found.facts };
  }
}

const ctx = (extra: Partial<StepContext> = {}): StepContext => ({
  sessionId: 's',
  runId: 'r',
  principal: jane,
  agentId: 'default',
  step: 1,
  signal: new AbortController().signal,
  ...extra,
});

describe('the built-in context provider user (X-03)', () => {
  it('gives the ref of the user and the other refs the user owns through, as JSON strings', () => {
    const text = userContextProvider().provide(
      ctx({
        principal: {
          ...jane,
          ownershipRefs: [
            jane.userRef,
            'group:default/team-a',
            'group:default/"x"',
          ],
        },
      }),
    );
    expect(text).toBe(
      [
        'The signed-in user is "user:default/jane".',
        'The user also owns things through: "group:default/team-a", "group:default/\\"x\\"".',
      ].join('\n'),
    );
  });

  it('has one line when the user owns through nothing else', () => {
    expect(userContextProvider().provide(ctx())).toBe(
      'The signed-in user is "user:default/jane".',
    );
  });

  it('gives nothing of the credentials', () => {
    const text = userContextProvider().provide(
      ctx({ principal: { ...jane, credentials: { token: 'secret-token' } } }),
    ) as string;
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('credentials');
  });

  it('gives nothing for a principal without a user ref', () => {
    expect(
      userContextProvider().provide(ctx({ principal: {} })),
    ).toBeUndefined();
  });
});

describe('the built-in context provider entity (X-03)', () => {
  const catalog = () =>
    new FakeEntityReader([
      {
        ref: 'component:default/shop',
        facts: {
          title: 'Shop',
          description: 'Sells things.',
          type: 'service',
          lifecycle: 'production',
          owner: 'group:default/team-a',
          system: 'commerce',
          tags: ['java'],
        },
      },
      {
        ref: 'component:default/secret',
        facts: { description: 'Only for the security team.' },
        readers: ['user:default/mallory'],
      },
    ]);

  it('gives the facts of the bound entity, read as the user of the run', async () => {
    const entities = catalog();
    const text = await entityContextProvider(entities).provide(
      ctx({ sessionEntityRef: 'component:default/shop' }),
    );
    expect(text).toBe(
      [
        'The session is about "component:default/shop".',
        JSON.stringify(
          {
            kind: 'component',
            namespace: 'default',
            name: 'shop',
            title: 'Shop',
            description: 'Sells things.',
            type: 'service',
            lifecycle: 'production',
            owner: 'group:default/team-a',
            system: 'commerce',
            tags: ['java'],
          },
          null,
          2,
        ),
      ].join('\n'),
    );
    expect(entities.reads).toEqual([
      { entityRef: 'component:default/shop', principal: jane },
    ]);
  });

  it('gives the same sentence for an entity the user cannot read and one that does not exist', async () => {
    const provider = entityContextProvider(catalog());
    const hidden = await provider.provide(
      ctx({ sessionEntityRef: 'component:default/secret' }),
    );
    const missing = await provider.provide(
      ctx({ sessionEntityRef: 'component:default/gone' }),
    );
    expect(hidden).toBe(
      'The session is about "component:default/secret", but its details are not available to this user.',
    );
    expect(hidden).not.toContain('security team');
    expect(missing).toBe(
      'The session is about "component:default/gone", but its details are not available to this user.',
    );
  });

  it('gives nothing when the session is bound to no entity', async () => {
    const entities = catalog();
    expect(
      await entityContextProvider(entities).provide(ctx()),
    ).toBeUndefined();
    expect(entities.reads).toEqual([]);
  });

  it('throws what the catalog throws, so the loop says the context is not available', async () => {
    const entities = catalog();
    entities.failing = true;
    await expect(
      entityContextProvider(entities).provide(
        ctx({ sessionEntityRef: 'component:default/shop' }),
      ),
    ).rejects.toThrow('catalog');
  });
});

describe('readableEntityRef (SE-02)', () => {
  it('gives the normalized ref of an entity the user can read', async () => {
    const entities = new FakeEntityReader([{ ref: 'component:default/shop' }]);
    expect(await readableEntityRef(entities, 'Component:Shop', jane)).toBe(
      'component:default/shop',
    );
  });

  it('gives nothing for a ref without a kind, without asking the catalog', async () => {
    const entities = new FakeEntityReader([{ ref: 'component:default/shop' }]);
    expect(await readableEntityRef(entities, 'shop', jane)).toBeUndefined();
    expect(entities.reads).toEqual([]);
  });
});

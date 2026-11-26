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

import { mockCredentials } from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { jane } from '../../integration/__testUtils__';
import { CatalogEntityReader } from './CatalogEntityReader';

describe('CatalogEntityReader', () => {
  it('reads the entity with the credentials of the user and keeps only the fields the chat uses', async () => {
    const catalog = catalogServiceMock.mock({
      getEntityByRef: jest.fn(async () => ({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'shop',
          namespace: 'default',
          title: 'Shop',
          description: 'Sells things.',
          tags: ['java'],
          annotations: { 'backstage.io/source-location': 'url:https://git.internal/shop' },
          links: [{ url: 'https://internal.example.com' }],
        },
        spec: {
          type: 'service',
          lifecycle: 'production',
          owner: 'group:default/team-a',
          system: 'commerce',
          dependsOn: ['resource:default/db'],
        },
      })),
    });
    const facts = await new CatalogEntityReader(catalog).read(
      'component:default/shop',
      jane,
    );
    expect(catalog.getEntityByRef).toHaveBeenCalledWith(
      'component:default/shop',
      { credentials: jane.credentials },
    );
    expect(jane.credentials).toEqual(mockCredentials.user('user:default/jane'));
    expect(facts).toEqual({
      kind: 'Component',
      namespace: 'default',
      name: 'shop',
      title: 'Shop',
      description: 'Sells things.',
      type: 'service',
      lifecycle: 'production',
      owner: 'group:default/team-a',
      system: 'commerce',
      tags: ['java'],
    });
  });

  it('leaves out the fields an entity does not have', async () => {
    const catalog = catalogServiceMock({
      entities: [
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: { name: 'team-a', namespace: 'default' },
          spec: { type: 'team', children: [] },
        },
      ],
    });
    expect(
      await new CatalogEntityReader(catalog).read('group:default/team-a', jane),
    ).toEqual({ kind: 'Group', namespace: 'default', name: 'team-a', type: 'team' });
  });

  it('gives nothing for an entity the catalog does not give', async () => {
    const catalog = catalogServiceMock({ entities: [] });
    expect(
      await new CatalogEntityReader(catalog).read('component:default/gone', jane),
    ).toBeUndefined();
  });
});

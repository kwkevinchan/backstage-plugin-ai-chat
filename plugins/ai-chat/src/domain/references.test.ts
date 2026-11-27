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
  entityRefWithKind,
  pageLabel,
  referenceInputOf,
  referenceTag,
} from './references';

describe('references of the screen', () => {
  it('takes an entity ref with a kind only, in the form the backend stores', () => {
    expect(entityRefWithKind('Component:payments')).toBe(
      'component:default/payments',
    );
    expect(entityRefWithKind('payments')).toBeUndefined();
    expect(entityRefWithKind('component:a b')).toBeUndefined();
  });

  it('shows an entity the backend read by its title, one it could not read by its name', () => {
    expect(
      referenceTag({
        kind: 'entity',
        entityRef: 'component:default/payments',
        readable: true,
        entity: {
          kind: 'Component',
          namespace: 'default',
          name: 'payments',
          title: 'Payments',
        },
      }),
    ).toMatchObject({ label: 'Payments', detail: 'Component' });
    expect(
      referenceTag({
        kind: 'entity',
        entityRef: 'component:default/secret',
        readable: false,
      }),
    ).toMatchObject({ label: 'secret', detail: 'component', unreadable: true });
  });

  it('shows a snippet without a title by its first words', () => {
    expect(
      referenceTag({ kind: 'text', text: 'one\n two   three' }),
    ).toMatchObject({ label: 'one two three' });
  });

  it('makes a stored reference a reference of a request again', () => {
    expect(
      referenceInputOf({
        kind: 'entity',
        entityRef: 'component:default/a',
        readable: false,
      }),
    ).toEqual({ kind: 'entity', entityRef: 'component:default/a' });
  });

  it('names the page by its entity, or by its path', () => {
    expect(pageLabel({ path: '/catalog' })).toBe('/catalog');
    expect(
      pageLabel({ path: '/x', entityRef: 'component:default/payments' }),
    ).toBe('payments');
  });
});

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

import { launchContextOf, panelMessagePage } from './launch';

describe('launchContextOf', () => {
  it('keeps a trimmed prompt and a valid entity reference', () => {
    expect(
      launchContextOf({
        prompt: '  where is this component?  ',
        entityRef: 'component:default/example.com',
      }),
    ).toEqual({
      prompt: 'where is this component?',
      entityRef: 'component:default/example.com',
    });
  });

  it('drops a blank prompt and an entity that is not an entity reference', () => {
    expect(launchContextOf({ prompt: '   ', entityRef: 'a b' })).toEqual({});
    expect(launchContextOf()).toEqual({});
  });
});

describe('panelMessagePage', () => {
  it('uses the launched entity instead of the one on the page', () => {
    expect(
      panelMessagePage(
        { entityRef: 'component:default/example.com' },
        { path: '/catalog', entityRef: 'component:default/other' },
      ),
    ).toEqual({
      path: '/catalog',
      entityRef: 'component:default/example.com',
    });
  });

  it('uses the page context when nothing was launched', () => {
    expect(
      panelMessagePage(undefined, {
        path: '/settings',
        entityRef: 'component:default/other',
      }),
    ).toEqual({
      path: '/settings',
      entityRef: 'component:default/other',
    });
    expect(panelMessagePage({ prompt: 'where' }, { path: '/catalog' })).toEqual(
      { path: '/catalog' },
    );
  });

  it('uses the path of the page at send time', () => {
    const launch = { entityRef: 'component:default/example.com' };
    expect(panelMessagePage(launch, { path: '/catalog' }).path).toBe(
      '/catalog',
    );
    expect(panelMessagePage(launch, { path: '/settings' })).toEqual({
      path: '/settings',
      entityRef: 'component:default/example.com',
    });
  });
});

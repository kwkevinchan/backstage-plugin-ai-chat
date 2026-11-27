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

import { createAiChatReferenceSourcesApi } from './referenceSourcesApi';

const First = () => null;
const Second = () => null;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('createAiChatReferenceSourcesApi', () => {
  it('keeps the sources in the order they were given', () => {
    const api = createAiChatReferenceSourcesApi([
      { id: 'docs-page', title: 'Documentation page', component: First },
      { id: 'template', title: 'Template', component: Second },
    ]);
    expect(api.getSources()).toEqual([
      { id: 'docs-page', title: 'Documentation page', component: First },
      { id: 'template', title: 'Template', component: Second },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the first source of an id and warns about the later one', () => {
    const api = createAiChatReferenceSourcesApi([
      { id: 'docs-page', title: 'Documentation page', component: First },
      { id: 'docs-page', title: 'Other', component: Second },
    ]);
    expect(api.getSources().map(source => source.component)).toEqual([First]);
    expect(warn).toHaveBeenCalledWith(
      'ai-chat: a reference source with the id docs-page is registered already; the later one is not used.',
    );
  });

  it('leaves out a source without an id, a title or a component', () => {
    const api = createAiChatReferenceSourcesApi([
      { id: '', title: 'No id', component: First },
      { id: 'no-title', title: '', component: First },
      {
        id: 'no-component',
        title: 'No component',
        component: undefined as never,
      },
    ]);
    expect(api.getSources()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

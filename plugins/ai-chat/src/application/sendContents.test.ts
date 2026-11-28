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

import { act, renderHook } from '@testing-library/react';
import type { ChatPageContext } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { createSendContentsStore, useSendContents } from './sendContents';

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('createSendContentsStore', () => {
  it('adds each reference once, in the form the backend takes', () => {
    const store = createSendContentsStore();
    store.add([
      { kind: 'entity', entityRef: 'Component:Default/Payments' },
      { kind: 'entity', entityRef: 'component:payments' },
      {
        kind: 'text',
        text: 'a\0b',
        title: '  Notes  ',
        url: 'ftp://example.com/notes',
      },
    ]);
    expect(store.getSnapshot().references.map(r => r.reference)).toEqual([
      { kind: 'entity', entityRef: 'component:default/payments' },
      { kind: 'text', text: 'ab', title: 'Notes' },
    ]);
  });

  it('leaves out an entity without a kind and an empty text, and warns', () => {
    const store = createSendContentsStore();
    store.add([
      { kind: 'entity', entityRef: 'default/payments' },
      { kind: 'text', text: '   ' },
    ]);
    expect(store.getSnapshot().references).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('takes no more than the limit, says so, and cuts the box when the limit goes down', () => {
    const store = createSendContentsStore();
    store.add(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({
        kind: 'entity' as const,
        entityRef: `component:default/${name}`,
      })),
    );
    expect(store.getSnapshot().references).toHaveLength(5);
    expect(store.getSnapshot().full).toBe(true);

    store.setLimits({ maxPerMessage: 3, maxTextLength: 4000 });
    expect(store.getSnapshot().references).toHaveLength(3);

    store.remove([store.getSnapshot().references[0].id]);
    expect(store.getSnapshot().references).toHaveLength(2);
    expect(store.getSnapshot().full).toBeUndefined();
  });

  it('cuts a text to the limit without splitting a character, and marks it', () => {
    const store = createSendContentsStore();
    store.add([{ kind: 'text', text: `${'a'.repeat(3999)}😀b` }]);
    const [draft] = store.getSnapshot().references;
    expect(draft.truncated).toBe(true);
    expect(draft.reference).toEqual({ kind: 'text', text: 'a'.repeat(3999) });
  });
});

describe('useSendContents', () => {
  const catalog: ChatPageContext = { path: '/catalog' };
  const settings: ChatPageContext = { path: '/settings' };

  it('keeps the page out while the user stays on it, and sends it again from another page on', () => {
    const store = createSendContentsStore();
    const { result, rerender } = renderHook(
      ({ page }) => useSendContents({ store, page }),
      { initialProps: { page: catalog } },
    );
    expect(result.current.sentPage).toEqual(catalog);

    act(() => result.current.excludePage());
    expect(result.current.pageIncluded).toBe(false);
    expect(result.current.sentPage).toBeUndefined();

    rerender({ page: { path: '/catalog' } });
    expect(result.current.sentPage).toBeUndefined();

    rerender({ page: settings });
    expect(result.current.sentPage).toEqual(settings);

    rerender({ page: catalog });
    expect(result.current.sentPage).toEqual(catalog);
  });

  it('counts another entity on the same path as another page', () => {
    const store = createSendContentsStore();
    const { result, rerender } = renderHook(
      ({ page }) => useSendContents({ store, page }),
      { initialProps: { page: catalog } },
    );
    act(() => result.current.excludePage());
    rerender({ page: { path: '/catalog', entityRef: 'component:default/a' } });
    expect(result.current.pageIncluded).toBe(true);
  });

  it('removes only the references of the message that was taken', () => {
    const store = createSendContentsStore();
    const { result } = renderHook(() =>
      useSendContents({ store, page: catalog }),
    );
    act(() =>
      result.current.add([
        { kind: 'entity', entityRef: 'component:default/a' },
      ]),
    );
    const box = result.current.take();
    act(() =>
      result.current.add([
        { kind: 'entity', entityRef: 'component:default/b' },
      ]),
    );
    act(() => box.sent());
    expect(box.references).toEqual([
      { kind: 'entity', entityRef: 'component:default/a' },
    ]);
    expect(result.current.references.map(r => r.reference)).toEqual([
      { kind: 'entity', entityRef: 'component:default/b' },
    ]);
  });
});

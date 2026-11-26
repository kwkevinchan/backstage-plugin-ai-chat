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

import { renderHook, waitFor } from '@testing-library/react';
import { useAttachmentUrl, useFileUrl } from './useAttachmentUrl';

function stubObjectUrls() {
  let next = 0;
  const create = jest.fn(() => {
    next += 1;
    return `blob:${next}`;
  });
  const revoke = jest.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
}

describe('useAttachmentUrl', () => {
  it('loads the image with the given loader and gives an object URL of its bytes', async () => {
    const { create } = stubObjectUrls();
    const blob = new Blob(['png']);
    const load = jest.fn().mockResolvedValue(blob);
    const { result } = renderHook(() => useAttachmentUrl('a', load));
    await waitFor(() => expect(result.current.url).toBe('blob:1'));
    expect(load).toHaveBeenCalledWith('a');
    expect(create).toHaveBeenCalledWith(blob);
    expect(result.current.failed).toBe(false);
  });

  it('revokes the URL when the image changes and when it unmounts, not on a render', async () => {
    const { revoke } = stubObjectUrls();
    const load = jest.fn().mockResolvedValue(new Blob(['png']));
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useAttachmentUrl(id, load),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.url).toBe('blob:1'));
    rerender({ id: 'a' });
    expect(revoke).not.toHaveBeenCalled();

    rerender({ id: 'b' });
    expect(revoke).toHaveBeenCalledWith('blob:1');
    expect(result.current.url).toBeUndefined();
    await waitFor(() => expect(result.current.url).toBe('blob:2'));

    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:2');
  });

  it('revokes a URL made after the component went away', async () => {
    const { revoke } = stubObjectUrls();
    let finish: (blob: Blob) => void = () => {};
    const load = jest.fn(
      () =>
        new Promise<Blob>(resolve => {
          finish = resolve;
        }),
    );
    const { unmount } = renderHook(() => useAttachmentUrl('a', load));
    await waitFor(() => expect(load).toHaveBeenCalled());
    unmount();
    finish(new Blob(['png']));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:1'));
  });

  it('says so when the image cannot be read', async () => {
    stubObjectUrls();
    const load = jest.fn().mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useAttachmentUrl('gone', load));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeUndefined();
  });
});

describe('useFileUrl', () => {
  it('gives an object URL of a file of the user and revokes it when the file changes or unmounts', () => {
    const { revoke } = stubObjectUrls();
    const first = new File(['a'], 'a.png', { type: 'image/png' });
    const second = new File(['b'], 'b.png', { type: 'image/png' });
    const { result, rerender, unmount } = renderHook(
      ({ file }) => useFileUrl(file),
      { initialProps: { file: first } },
    );
    expect(result.current).toBe('blob:1');
    rerender({ file: second });
    expect(revoke).toHaveBeenCalledWith('blob:1');
    expect(result.current).toBe('blob:2');
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:2');
  });
});

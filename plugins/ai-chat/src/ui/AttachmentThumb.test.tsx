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

import { render, screen } from '@testing-library/react';
import type { ChatAttachment } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { AttachmentThumb, IMAGE_GONE } from './AttachmentThumb';

const image = (id: string): ChatAttachment => ({
  id,
  mediaType: 'image/png',
  name: `${id}.png`,
  size: 4,
});

describe('AttachmentThumb', () => {
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    let n = 0;
    URL.createObjectURL = jest.fn(() => `blob:msg-${++n}`);
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it('revokes the object URL when the image changes and when the thumbnail unmounts', async () => {
    const load = jest.fn(async () => new Blob(['x'], { type: 'image/png' }));
    const { rerender, unmount } = render(
      <AttachmentThumb attachment={image('a')} load={load} />,
    );

    const first = await screen.findByRole('img', { name: 'a.png' });
    const firstUrl = first.getAttribute('src');
    rerender(<AttachmentThumb attachment={image('b')} load={load} />);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstUrl);

    const second = await screen.findByRole('img', { name: 'b.png' });
    const secondUrl = second.getAttribute('src');
    expect(secondUrl).not.toBe(firstUrl);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(secondUrl);
  });

  it('says the image no longer exists when it cannot be loaded', async () => {
    const load = jest.fn().mockRejectedValue(new Error('missing'));
    render(<AttachmentThumb attachment={image('shot')} load={load} />);
    expect(
      await screen.findByText(`shot.png. ${IMAGE_GONE}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

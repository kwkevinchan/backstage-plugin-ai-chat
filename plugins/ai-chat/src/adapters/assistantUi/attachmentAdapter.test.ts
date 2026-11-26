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

import type { AppendMessage, PendingAttachment } from '@assistant-ui/react';
import {
  WRONG_TYPE_TEXT,
  chatAttachmentOf,
  createAttachmentAdapter,
  outgoingOf,
  toCompleteAttachment,
  tooLargeText,
  tooManyText,
  type AttachmentSource,
} from './attachmentAdapter';

// The contract of the attachment adapter: what assistant-ui gets from add,
// send and remove, on the uploads of the backend.

const limits = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  maxPerMessage: 2,
  maxBytes: 100,
};

const png = (name = 'dot.png', size = 10) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

const uploadedOf = (file: File, id = `att-${file.name}`) => ({
  id,
  mediaType: file.type,
  name: file.name,
  size: file.size,
});

function setup(overrides: Partial<AttachmentSource> = {}, inBox = 0) {
  const upload = jest.fn(async (file: File) => uploadedOf(file));
  const onAdd = jest.fn();
  const count = { inBox };
  const adapter = createAttachmentAdapter(
    { limits, upload, onAdd, ...overrides },
    () => count.inBox,
  );
  return { adapter, upload, onAdd, count };
}

/** Every state that `add` gives for a file, as assistant-ui reads them. */
async function statesOf(
  result: ReturnType<ReturnType<typeof setup>['adapter']['add']>,
  onEach?: () => void,
) {
  const states: PendingAttachment[] = [];
  if (Symbol.asyncIterator in result) {
    for await (const state of result) {
      states.push(state);
      onEach?.();
    }
  } else {
    states.push(await result);
  }
  return states;
}

describe('attachment adapter: accept and the checks of add', () => {
  it('accepts the four image types', () => {
    expect(setup().adapter.accept).toBe(
      'image/png,image/jpeg,image/webp,image/gif',
    );
  });

  it('does not upload a file of another type, a file over the size, or one image too many, and says why', async () => {
    const { adapter, upload, onAdd } = setup({}, 2);
    await expect(
      statesOf(
        adapter.add({ file: new File(['x'], 'a.txt', { type: 'text/plain' }) }),
      ),
    ).rejects.toThrow(WRONG_TYPE_TEXT);
    await expect(
      statesOf(adapter.add({ file: png('big.png', 101) })),
    ).rejects.toThrow(tooLargeText(100));
    await expect(statesOf(adapter.add({ file: png() }))).rejects.toThrow(
      tooManyText(2),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(onAdd).toHaveBeenCalledTimes(3);
  });

  it('counts the images added together before the box shows them', async () => {
    const { adapter, upload } = setup();
    // One drop of three files: each add starts before the box has any.
    const results = [png('a.png'), png('b.png'), png('c.png')].map(file =>
      statesOf(adapter.add({ file })),
    );
    const settled = await Promise.allSettled(results);
    expect(settled.map(r => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
    expect((settled[2] as PromiseRejectedResult).reason.message).toBe(
      tooManyText(2),
    );
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('says so in the size limit in KB and MB', () => {
    expect(tooLargeText(5 * 1024 * 1024)).toBe(
      'This image is over the size limit of 5 MB.',
    );
    expect(tooLargeText(2048)).toBe(
      'This image is over the size limit of 2 KB.',
    );
    expect(tooManyText(1)).toBe('A message can have at most 1 image.');
  });
});

describe('attachment adapter: the upload', () => {
  it('uploads a good image at once: uploading, then complete with the id of the backend and no URL', async () => {
    const { adapter, upload } = setup();
    const file = png();
    const states = await statesOf(adapter.add({ file }));
    expect(upload).toHaveBeenCalledWith(file, expect.any(Function));
    expect(states.map(s => s.status)).toEqual([
      { type: 'running', reason: 'uploading', progress: 0 },
      { type: 'complete' },
    ]);
    expect(new Set(states.map(s => s.id)).size).toBe(1);
    expect(states[0]).toEqual(
      expect.objectContaining({
        type: 'image',
        name: 'dot.png',
        contentType: 'image/png',
        file,
      }),
    );
    expect(states[1].content).toEqual([
      { type: 'data', name: 'chat-attachment', data: uploadedOf(file) },
    ]);
    expect(chatAttachmentOf(states[1])?.id).toBe('att-dot.png');
  });

  it('keeps an image whose upload failed, with the reason', async () => {
    const { adapter } = setup({
      upload: jest.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with 413'), {
          cause: new Error('An image may be at most 100 bytes'),
        }),
      ),
    });
    const states = await statesOf(adapter.add({ file: png() }));
    expect(states[states.length - 1].status).toEqual({
      type: 'incomplete',
      reason: 'error',
      message: 'An image may be at most 100 bytes',
    });
  });

  it('send fails with the reason of the failed upload, and uploads nothing again', async () => {
    const upload = jest.fn().mockRejectedValue(new Error('offline'));
    const { adapter } = setup({ upload });
    const states = await statesOf(adapter.add({ file: png() }));
    const failed = states[states.length - 1];
    expect(failed.status.type).toBe('incomplete');
    await expect(adapter.send(failed)).rejects.toThrow('offline');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('remove: an image removed while it uploads is not taken', async () => {
    let finish: () => void = () => {};
    const upload = jest.fn(
      (file: File) =>
        new Promise<ReturnType<typeof uploadedOf>>(resolve => {
          finish = () => resolve(uploadedOf(file));
        }),
    );
    const { adapter } = setup({ upload });
    const added = adapter.add({ file: png() }) as AsyncGenerator<
      PendingAttachment,
      void
    >;
    const first = await added.next();
    expect(first.done).toBe(false);
    const draft = first.value as PendingAttachment;
    const rest = added.next();
    await adapter.remove(draft);
    finish();
    expect(await rest).toEqual({ done: true, value: undefined });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('attachment adapter: the message', () => {
  it('outgoingOf gives the text and our attachments of a message', () => {
    const image = uploadedOf(png());
    const message = {
      content: [{ type: 'text', text: ' look ' }],
      attachments: [toCompleteAttachment(image)],
    } as unknown as AppendMessage;
    expect(outgoingOf(message)).toEqual({ text: 'look', attachments: [image] });
    expect(
      outgoingOf({ content: [], attachments: [] } as unknown as AppendMessage),
    ).toEqual({ text: '' });
  });
});

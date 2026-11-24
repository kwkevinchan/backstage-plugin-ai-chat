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

import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInTestApp } from '@backstage/test-utils';
import type { ChatAttachment } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { Composer, type ImageInputLimits } from './Composer';

const limits: ImageInputLimits = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  maxPerMessage: 4,
  maxBytes: 1024,
};

const fileOf = (name: string, type: string, size = 8) =>
  new File([new Uint8Array(size)], name, { type });

const png = (name = 'dot.png', size = 8) => fileOf(name, 'image/png', size);

const uploaded = (file: File): ChatAttachment => ({
  id: `id-${file.name}`,
  mediaType: file.type,
  name: file.name,
  size: file.size,
});

async function show(
  props: {
    images?: ImageInputLimits | false;
    onSend?: jest.Mock;
    uploadImage?: jest.Mock;
  } = {},
) {
  const onSend = props.onSend ?? jest.fn().mockResolvedValue(true);
  const uploadImage =
    props.uploadImage ?? jest.fn(async (file: File) => uploaded(file));
  const images = props.images === false ? undefined : props.images ?? limits;
  await renderInTestApp(
    <Composer
      disabled={false}
      onSend={onSend}
      images={images}
      uploadImage={images ? uploadImage : undefined}
    />,
  );
  return { onSend, uploadImage };
}

const choose = () => screen.getByLabelText('Choose images');

describe('Composer images', () => {
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    let n = 0;
    URL.createObjectURL = jest.fn(() => `blob:draft-${++n}`);
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it('adds an image from the attach button', async () => {
    const { uploadImage } = await show();
    await userEvent.upload(choose(), png());
    expect(
      await screen.findByRole('img', { name: 'dot.png' }),
    ).toBeInTheDocument();
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
  });

  it('adds an image that is pasted', async () => {
    const { uploadImage } = await show();
    fireEvent.paste(screen.getByLabelText('Message'), {
      clipboardData: {
        files: [png('pasted.png')],
        getData: () => '',
      },
    });
    expect(
      await screen.findByRole('img', { name: 'pasted.png' }),
    ).toBeInTheDocument();
    expect(uploadImage).toHaveBeenCalledTimes(1);
  });

  it('adds an image that is dropped', async () => {
    const { uploadImage } = await show();
    fireEvent.drop(screen.getByLabelText('Message'), {
      dataTransfer: { files: [png('dropped.png')] },
    });
    expect(
      await screen.findByRole('img', { name: 'dropped.png' }),
    ).toBeInTheDocument();
    expect(uploadImage).toHaveBeenCalledTimes(1);
  });

  it('does not upload a file of the wrong type, one that is too large, or one past the limit, and says why', async () => {
    const uploadImage = jest.fn(async (file: File) => uploaded(file));
    await show({
      uploadImage,
      images: { ...limits, maxPerMessage: 1, maxBytes: 10 },
    });
    const input = choose() as HTMLInputElement;
    // The file dialog's accept list is not a guarantee: the change event can
    // still carry a file of another type, and the box has to refuse it.
    const select = (file: File) => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
      });
      fireEvent.change(input);
    };

    select(fileOf('notes.txt', 'text/plain', 4));
    expect(
      await screen.findByText(
        'Only PNG, JPEG, WebP and GIF images can be attached.',
      ),
    ).toBeInTheDocument();

    select(png('big.png', 11));
    expect(
      screen.getByText('This image is over the size limit of 10 bytes.'),
    ).toBeInTheDocument();

    select(png('ok.png', 4));
    expect(
      await screen.findByRole('img', { name: 'ok.png' }),
    ).toBeInTheDocument();

    select(png('extra.png', 4));
    expect(
      screen.getByText('A message can have at most 1 image.'),
    ).toBeInTheDocument();
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadImage.mock.calls[0][0].name).toBe('ok.png');
  });

  it('sends without an image that was removed', async () => {
    const { onSend } = await show();
    await userEvent.upload(choose(), png());
    expect(
      await screen.findByRole('img', { name: 'dot.png' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove dot.png' }),
    );
    await userEvent.type(screen.getByLabelText('Message'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ text: 'hello' }));
    expect(JSON.stringify(onSend.mock.calls)).not.toContain('id-dot.png');
  });

  it('keeps the text when an upload is refused and shows the reason', async () => {
    const uploadImage = jest.fn(async () => {
      throw new Error('An image may be at most 5242880 bytes');
    });
    await show({ uploadImage });
    const box = screen.getByLabelText('Message');
    await userEvent.type(box, 'keep me');
    await userEvent.upload(choose(), png());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An image may be at most 5242880 bytes',
    );
    expect(box).toHaveValue('keep me');
  });

  it('shows no attach button and does not upload a pasted image when images are off', async () => {
    const uploadImage = jest.fn();
    await show({ images: false, uploadImage });
    expect(
      screen.queryByRole('button', { name: 'Attach' }),
    ).not.toBeInTheDocument();
    fireEvent.paste(screen.getByLabelText('Message'), {
      clipboardData: {
        files: [png()],
        getData: () => '',
      },
    });
    expect(uploadImage).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows that an image is uploading until the upload finishes', async () => {
    let finish: (attachment: ChatAttachment) => void = () => {};
    const uploadImage = jest.fn(
      () =>
        new Promise<ChatAttachment>(resolve => {
          finish = resolve;
        }),
    );
    await show({ uploadImage });
    await userEvent.upload(choose(), png());
    expect(await screen.findByText('Uploading...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    finish(uploaded(png()));
    await waitFor(() =>
      expect(screen.queryByText('Uploading...')).not.toBeInTheDocument(),
    );
  });

  it('enables Send when the draft has an uploaded image and no text', async () => {
    const { onSend } = await show();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.upload(choose(), png());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({
        text: '',
        attachments: [expect.objectContaining({ id: 'id-dot.png' })],
      }),
    );
  });
});

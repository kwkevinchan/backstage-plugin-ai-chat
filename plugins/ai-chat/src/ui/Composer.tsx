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
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@backstage/ui';
import {
  MAX_MESSAGE_LENGTH,
  type ChatAttachment,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { OutgoingMessage } from '../domain/types';
import { cx } from './styles';

/** What the screen checks before it uploads an image. */
export interface ImageInputLimits {
  mediaTypes: string[];
  maxPerMessage: number;
  maxBytes: number;
}

export interface ComposerProps {
  /**
   * Enter, and the Send button. Resolves with `false` when the message was not
   * sent at all.
   */
  onSend(draft: OutgoingMessage): Promise<boolean | void> | void;
  /**
   * Ctrl or Cmd with Enter, and the Queue button, which shows only with this.
   * Without it Ctrl or Cmd with Enter does what Enter does.
   */
  onQueue?(draft: OutgoingMessage): Promise<boolean | void> | void;
  /** A response is on its way that the new message cannot join. */
  disabled: boolean;
  /** Shown above the box. */
  hint?: string;
  /** The text of the empty box. */
  placeholder?: string;
  /** The name of the main button; default Send. */
  sendLabel?: string;
  /** Set while a run is active: shows Stop. */
  onStop?(): void;
  /**
   * When set, together with `uploadImage`, the box can attach images. Omit it
   * when the model cannot read images: no button, and a pasted image is not
   * uploaded.
   */
  images?: ImageInputLimits;
  /**
   * Uploads one file that has already passed the checks. Rejects with an
   * `Error` whose message is shown on the draft.
   */
  uploadImage?(
    file: File,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<ChatAttachment>;
}

const DEFAULT_PLACEHOLDER =
  'Write a message (Enter sends, Shift+Enter starts a new line)';

const WRONG_TYPE = 'Only PNG, JPEG, WebP and GIF images can be attached.';

interface DraftImage {
  key: string;
  name: string;
  preview: string;
  status: 'uploading' | 'done' | 'failed';
  loaded: number;
  total: number;
  attachment?: ChatAttachment;
  error?: string;
}

interface Rejection {
  key: string;
  text: string;
}

function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  const kb = 1024;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb} MB`;
  if (bytes >= kb && bytes % kb === 0) return `${bytes / kb} KB`;
  return `${bytes} bytes`;
}

/** The input box with Send, Queue while a run is active, Stop, and images. */
export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<DraftImage[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const imagesRef = useRef(images);
  const ids = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesOn = Boolean(props.images && props.uploadImage);
  const canAttach = imagesOn && !props.disabled;

  const setDraftImages = (next: DraftImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };
  const nextId = () => {
    ids.current += 1;
    return `img-${ids.current}`;
  };

  useEffect(
    () => () => {
      imagesRef.current.forEach(item => URL.revokeObjectURL(item.preview));
    },
    [],
  );

  const takeFiles = (files: File[]) => {
    if (!canAttach || !props.images || !props.uploadImage) return;
    const limits = props.images;
    const upload = props.uploadImage;
    let taken = imagesRef.current.filter(
      item => item.status !== 'failed',
    ).length;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (!limits.mediaTypes.includes(file.type)) {
        rejected.push(WRONG_TYPE);
        continue;
      }
      if (file.size > limits.maxBytes) {
        rejected.push(
          `This image is over the size limit of ${formatBytes(
            limits.maxBytes,
          )}.`,
        );
        continue;
      }
      if (taken >= limits.maxPerMessage) {
        const count = limits.maxPerMessage;
        rejected.push(
          `A message can have at most ${count} ${
            count === 1 ? 'image' : 'images'
          }.`,
        );
        continue;
      }
      accepted.push(file);
      taken += 1;
    }
    if (rejected.length > 0) {
      setRejections(current => [
        ...current,
        ...rejected.map(text => ({ key: nextId(), text })),
      ]);
    }
    for (const file of accepted) {
      const key = nextId();
      const preview = URL.createObjectURL(file);
      const entry: DraftImage = {
        key,
        name: file.name || 'image',
        preview,
        status: 'uploading',
        loaded: 0,
        total: file.size,
      };
      setDraftImages([...imagesRef.current, entry]);
      upload(file, (loaded, total) => {
        setDraftImages(
          imagesRef.current.map(item =>
            item.key === key ? { ...item, loaded, total } : item,
          ),
        );
      })
        .then(attachment => {
          setDraftImages(
            imagesRef.current.map(item =>
              item.key === key ? { ...item, status: 'done', attachment } : item,
            ),
          );
        })
        .catch(error => {
          const message =
            error instanceof Error
              ? error.message
              : 'The image could not be uploaded.';
          setDraftImages(
            imagesRef.current.map(item =>
              item.key === key
                ? { ...item, status: 'failed', error: message }
                : item,
            ),
          );
        });
    }
  };

  const removeImage = (key: string) => {
    const item = imagesRef.current.find(image => image.key === key);
    if (item) URL.revokeObjectURL(item.preview);
    setDraftImages(imagesRef.current.filter(image => image.key !== key));
  };

  const submit = async (queue: boolean) => {
    if (props.disabled) return;
    const text = draft.trim();
    const current = imagesRef.current;
    if (current.some(item => item.status === 'uploading')) return;
    const done = current.filter(
      item => item.status === 'done' && item.attachment,
    );
    if (!text && done.length === 0) return;
    const attachments = done.map(item => item.attachment!);
    const snapshot = { text, done };
    setDraft('');
    setDraftImages(current.filter(item => item.status !== 'done'));
    const handler = queue && props.onQueue ? props.onQueue : props.onSend;
    const sent = await handler({
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (sent === false) {
      setDraft(typed => typed || snapshot.text);
      const latest = imagesRef.current;
      const added = latest.some(
        item => item.status === 'done' || item.status === 'uploading',
      );
      if (added) {
        snapshot.done.forEach(item => URL.revokeObjectURL(item.preview));
      } else {
        setDraftImages([...snapshot.done, ...latest]);
      }
      return;
    }
    snapshot.done.forEach(item => URL.revokeObjectURL(item.preview));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    const modified = event.ctrlKey || event.metaKey;
    if (event.shiftKey && !modified) return;
    event.preventDefault();
    submit(modified);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (!pasted) event.preventDefault();
    takeFiles(Array.from(files));
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    event.preventDefault();
    setDragOver(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (!canAttach) return;
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) takeFiles(Array.from(files));
  };

  const uploading = images.some(item => item.status === 'uploading');
  const hasImage = images.some(item => item.status === 'done');
  const empty = !draft.trim() && !hasImage;
  const blocked = props.disabled || empty || uploading;

  return (
    <>
      {props.hint && (
        <div className={cx('chat-composer-hint')}>{props.hint}</div>
      )}
      <div
        className={cx('chat-composer-box', dragOver && 'chat-composer-drop')}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {rejections.length > 0 && (
          <div className={cx('chat-rejections')}>
            {rejections.map(rejection => (
              <div key={rejection.key} role="alert">
                {rejection.text}
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <ul className={cx('chat-drafts')}>
            {images.map(item => (
              <li key={item.key} className={cx('chat-draft')}>
                <img src={item.preview} alt={item.name} />
                {item.status === 'uploading' && (
                  <span className={cx('chat-draft-meta')}>
                    Uploading...
                    <progress
                      aria-label={`Uploading ${item.name}`}
                      max={item.total || 1}
                      value={item.loaded}
                    />
                  </span>
                )}
                {item.status === 'failed' && (
                  <span className={cx('chat-draft-meta')} role="alert">
                    {item.error}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => removeImage(item.key)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={cx('chat-composer')}>
          {imagesOn && (
            <>
              <Button
                variant="secondary"
                isDisabled={!canAttach}
                onPress={() => fileInput.current?.click()}
              >
                Attach
              </Button>
              <input
                ref={fileInput}
                className={cx('chat-file-input')}
                type="file"
                multiple
                accept={props.images?.mediaTypes.join(',')}
                aria-label="Choose images"
                onChange={event => {
                  const files = event.target.files;
                  if (files && files.length > 0) takeFiles(Array.from(files));
                  event.target.value = '';
                }}
              />
            </>
          )}
          <textarea
            className={cx('chat-composer-input')}
            aria-label="Message"
            placeholder={props.placeholder ?? DEFAULT_PLACEHOLDER}
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {props.onStop && (
            <Button variant="secondary" onPress={props.onStop}>
              Stop
            </Button>
          )}
          {props.onQueue && (
            <Button
              variant="secondary"
              isDisabled={blocked}
              onPress={() => submit(true)}
            >
              Queue
            </Button>
          )}
          <Button
            variant="primary"
            isDisabled={blocked}
            onPress={() => submit(false)}
          >
            {props.sendLabel ?? 'Send'}
          </Button>
        </div>
      </div>
    </>
  );
}

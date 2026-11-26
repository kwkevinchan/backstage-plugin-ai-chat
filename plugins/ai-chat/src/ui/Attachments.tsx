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

import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAuiEvent,
  useAuiState,
} from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import type { ChatAttachment } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import {
  WRONG_TYPE_TEXT,
  chatAttachmentOf,
} from '../adapters/assistantUi/attachmentAdapter';
import { useAttachmentUrl, useFileUrl } from '../application/useAttachmentUrl';
import { cx } from './styles';

/** Shown with the file name when the bytes of an image can no longer be read. */
export const IMAGE_GONE_TEXT = 'The image no longer exists.';

/** Reads the bytes of one image of the session, with the signed-in request. */
export const AttachmentLoaderContext = createContext<
  ((attachmentId: string) => Promise<Blob>) | undefined
>(undefined);

/** One image of a message, loaded with the signed-in request. */
export function ChatImage({ attachment }: { attachment: ChatAttachment }) {
  const load = useContext(AttachmentLoaderContext);
  if (!load) return null;
  return <LoadedImage attachment={attachment} load={load} />;
}

function LoadedImage({
  attachment,
  load,
}: {
  attachment: ChatAttachment;
  load: (attachmentId: string) => Promise<Blob>;
}) {
  const { url, failed } = useAttachmentUrl(attachment.id, load);
  if (failed) {
    return (
      <span className={cx('chat-image-missing')}>
        {attachment.name}. {IMAGE_GONE_TEXT}
      </span>
    );
  }
  if (!url) {
    return (
      <span
        className={cx('chat-image', 'chat-image-loading')}
        aria-label={`Loading ${attachment.name}`}
        role="img"
      />
    );
  }
  return <img className={cx('chat-image')} src={url} alt={attachment.name} />;
}

/** The images of a message, an inserted message or a queued one. */
export function ChatImages({
  attachments,
  className,
}: {
  attachments: readonly ChatAttachment[];
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className={cx('chat-images', className)}>
      {attachments.map(attachment => (
        <li key={attachment.id}>
          <ChatImage attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

/** An attachment of a message (in `MessagePrimitive.Attachments`). */
function MessageImage() {
  const attachment = useAuiState(s => chatAttachmentOf(s.attachment));
  if (!attachment) return null;
  return (
    <li>
      <ChatImage attachment={attachment} />
    </li>
  );
}

export const messageAttachmentComponents = { Image: MessageImage };

/** An image of the draft: the file of the user, how its upload goes, and Remove. */
function DraftImage() {
  const name = useAuiState(s => s.attachment.name);
  const file = useAuiState(s => s.attachment.file);
  const status = useAuiState(s => s.attachment.status);
  const preview = useFileUrl(file);
  return (
    <AttachmentPrimitive.Root className={cx('chat-draft')}>
      {/* An image put back into the box after a refused send has no file. */}
      {preview ? (
        <img src={preview} alt={name} />
      ) : (
        <span className={cx('chat-draft-name')}>{name}</span>
      )}
      {status.type === 'running' && (
        <span className={cx('chat-draft-meta')} role="status">
          Uploading...
        </span>
      )}
      {status.type === 'incomplete' && (
        <span
          className={cx('chat-draft-meta', 'chat-draft-failed')}
          role="alert"
        >
          {status.message ?? 'The image could not be uploaded.'}
        </span>
      )}
      <AttachmentPrimitive.Remove asChild>
        <button
          type="button"
          className={cx('chat-draft-remove')}
          aria-label={`Remove ${name}`}
        >
          Remove
        </button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

const draftComponents = { Image: DraftImage, Attachment: DraftImage };

/** The images of the draft, above the box. */
export function DraftImages() {
  const count = useAuiState(s => s.composer.attachments.length);
  if (count === 0) return null;
  return (
    <div className={cx('chat-drafts')}>
      <ComposerPrimitive.Attachments components={draftComponents} />
    </div>
  );
}

/** The attach button; only when the runtime takes attachments. */
export function AttachButton() {
  const enabled = useAuiState(s => s.thread.capabilities.attachments);
  if (!enabled) return null;
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <Button variant="secondary">Attach</Button>
    </ComposerPrimitive.AddAttachment>
  );
}

interface Reason {
  key: number;
  text: string;
}

/**
 * Why images were not taken. The reasons of one attach (one choice of files,
 * one paste, one drop: their checks run in the same task) replace those of
 * the attach before; a send clears them. `begin` is called when an attach
 * starts, also when it takes every file.
 */
export class RejectionNotes {
  private reasons: readonly Reason[] = [];
  private open = false;
  private keys = 0;
  private readonly listeners = new Set<() => void>();

  readonly begin = () => {
    if (this.open) return;
    this.open = true;
    setTimeout(() => {
      this.open = false;
    }, 0);
    this.set([]);
  };

  readonly add = (text: string) => {
    this.begin();
    this.keys += 1;
    this.set([...this.reasons, { key: this.keys, text }]);
  };

  readonly clear = () => this.set([]);

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.reasons;

  private set(reasons: readonly Reason[]) {
    if (reasons.length === 0 && this.reasons.length === 0) return;
    this.reasons = reasons;
    this.listeners.forEach(listener => listener());
  }
}

/** The reasons of `notes`, fed by the errors of the composer. */
export function AttachmentRejections({ notes }: { notes: RejectionNotes }) {
  useAuiEvent('composer.attachmentAddError', event => {
    // A failed upload is shown on its image in the draft.
    if (event.attachmentId !== undefined) return;
    notes.add(
      event.reason === 'not-accepted' ? WRONG_TYPE_TEXT : event.message,
    );
  });
  useAuiEvent('composer.send', () => notes.clear());
  const reasons = useSyncExternalStore(notes.subscribe, notes.getSnapshot);
  if (reasons.length === 0) return null;
  return (
    <div className={cx('chat-rejections')}>
      {reasons.map(reason => (
        <div key={reason.key} role="alert">
          {reason.text}
        </div>
      ))}
    </div>
  );
}

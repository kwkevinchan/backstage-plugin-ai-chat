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

import type { ChatAttachment } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { useAttachmentUrl } from '../application/useAttachmentUrl';
import { cx } from './styles';

/** Shown with the file name when the bytes can no longer be read. */
export const IMAGE_GONE = 'The image no longer exists.';

export function AttachmentList(props: {
  attachments: ChatAttachment[];
  load: (id: string) => Promise<Blob>;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <ul className={cx('chat-attachments')}>
      {props.attachments.map(attachment => (
        <li key={attachment.id}>
          <AttachmentThumb attachment={attachment} load={props.load} />
        </li>
      ))}
    </ul>
  );
}

export function AttachmentThumb(props: {
  attachment: ChatAttachment;
  load: (id: string) => Promise<Blob>;
}) {
  const { attachment } = props;
  const { url, failed } = useAttachmentUrl(attachment.id, props.load);
  if (failed) {
    return (
      <span className={cx('chat-thumb-missing')}>
        {attachment.name}. {IMAGE_GONE}
      </span>
    );
  }
  if (!url) return null;
  return <img className={cx('chat-thumb')} src={url} alt={attachment.name} />;
}

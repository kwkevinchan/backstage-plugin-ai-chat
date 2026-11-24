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

import { cx } from './styles';

export interface PendingInsertsProps {
  /** The messages that were added to the run and not read yet. */
  items: { seq: number; text: string }[];
}

/** The messages that wait for the model to read them: above the input box. */
export function PendingInserts({ items }: PendingInsertsProps) {
  if (items.length === 0) return null;
  return (
    <ul className={cx('chat-pending')} aria-label="Waiting to be read">
      {items.map(item => (
        <li key={item.seq} className={cx('chat-pending-item')}>
          <span className={cx('chat-pending-text')}>{item.text}</span>
          <span className={cx('chat-pending-label')}>
            The agent has not read this yet. It will at the next step.
          </span>
        </li>
      ))}
    </ul>
  );
}

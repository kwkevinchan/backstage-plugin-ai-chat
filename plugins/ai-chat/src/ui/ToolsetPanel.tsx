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

import type { ChatToolset } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { cx } from './styles';

export interface ToolsetPanelProps {
  toolsets: ChatToolset[];
  enabled: string[];
  disabled?: boolean;
  onChange(enabled: string[]): void;
}

/** The toolsets of a session, each with a switch. */
export function ToolsetPanel(props: ToolsetPanelProps) {
  const { toolsets, enabled } = props;
  if (toolsets.length === 0) return null;
  const toggle = (id: string, on: boolean) =>
    props.onChange(
      on
        ? [...enabled.filter(e => e !== id), id]
        : enabled.filter(e => e !== id),
    );
  return (
    <details className={cx('chat-toolsets')}>
      <summary>
        Toolsets ({toolsets.filter(t => enabled.includes(t.id)).length} of{' '}
        {toolsets.length} on)
      </summary>
      <div className={cx('chat-toolsets-list')}>
        {toolsets.map(toolset => (
          <label key={toolset.id}>
            <input
              type="checkbox"
              checked={enabled.includes(toolset.id)}
              disabled={props.disabled}
              onChange={event => toggle(toolset.id, event.target.checked)}
            />{' '}
            {toolset.title ?? toolset.id}
            {toolset.egress && (
              <span className={cx('chat-id')}> sends data out</span>
            )}
          </label>
        ))}
      </div>
    </details>
  );
}

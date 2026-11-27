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

import type { ReactNode } from 'react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { aiChatPanelApiRef } from '../api';
import type { AiChatReference } from '../references';
import { useAiChatPanel } from '../application/useAiChatPanel';

/**
 * Props of {@link AiChatLauncher}. All fields are optional. A prompt starts
 * a new conversation. An entity reference is sent with that conversation.
 * References go into the box of the panel for the next message.
 *
 * @public
 */
export interface AiChatLauncherProps {
  /** The first message of a new conversation. */
  prompt?: string;
  /** The entity this conversation is about, `kind:namespace/name`. */
  entityRef?: string;
  /** References for the next message: entities and text snippets. */
  references?: AiChatReference[];
  /** CSS class applied to the button. */
  className?: string;
  /** The button label. Defaults to "Ask AI chat". */
  children?: ReactNode;
}

/**
 * A button that opens the side panel. With a prompt or an entity reference,
 * that launch is carried into the conversation. With neither, the panel
 * opens and nothing is replaced. When the chat plugin is not installed, no
 * button is rendered.
 *
 * Render it from another plugin. It does not import the chat plugin.
 *
 * @public
 */
export function AiChatLauncher(props: AiChatLauncherProps): JSX.Element | null {
  const api = useApiHolder().get(aiChatPanelApiRef);
  const { isOpen } = useAiChatPanel();
  if (!api) return null;
  const { prompt, entityRef, references, className, children } = props;
  return (
    <button
      type="button"
      className={className}
      aria-expanded={isOpen}
      onClick={() => {
        if (
          prompt === undefined &&
          entityRef === undefined &&
          references === undefined
        ) {
          api.open();
        } else {
          api.open({
            ...(prompt !== undefined && { prompt }),
            ...(entityRef !== undefined && { entityRef }),
            ...(references !== undefined && { references }),
          });
        }
      }}
    >
      {children ?? 'Ask AI chat'}
    </button>
  );
}

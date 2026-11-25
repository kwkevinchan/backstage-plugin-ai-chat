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
import { render, type RenderResult } from '@testing-library/react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import {
  useSessionRuntime,
  type SessionRuntimeOptions,
} from '../../adapters/assistantUi/sessionRuntime';
import type { ChatUiMessage } from '../../domain/types';
import { MessageList, type MessageListProps } from '../MessageList';

type Options = Partial<SessionRuntimeOptions> & {
  list?: Partial<MessageListProps>;
  children?: ReactNode;
};

function Harness({
  messages,
  options,
}: {
  messages: readonly ChatUiMessage[];
  options: Options;
}) {
  const { list, children, ...runtime } = options;
  const value = useSessionRuntime({
    isRunning: false,
    onSend: () => undefined,
    ...runtime,
    messages,
  });
  return (
    <AssistantRuntimeProvider runtime={value}>
      <MessageList busy={false} disabled={false} {...list} />
      {children}
    </AssistantRuntimeProvider>
  );
}

/** Renders messages through the runtime and the message list of the plugin. */
export function renderThread(
  messages: readonly ChatUiMessage[],
  options: Options = {},
): RenderResult {
  return render(<Harness messages={messages} options={options} />);
}

/** An assistant message with one text part. */
export function assistantText(text: string, id = 'run_1'): ChatUiMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

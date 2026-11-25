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

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import type { ChatUiMessage } from '../../domain/types';
import {
  useSessionRuntime,
  type SessionRuntimeOptions,
} from './sessionRuntime';

// The runtime with the bare primitives of assistant-ui: what each action of
// the screen calls on the chat.

function Tool(props: ToolCallMessagePartProps) {
  return (
    <div data-testid="call">
      {props.toolName}
      {props.approval && props.approval.approved === undefined && (
        <>
          <button onClick={() => props.respondToApproval({ approved: true })}>
            Approve
          </button>
          <button onClick={() => props.respondToApproval({ approved: false })}>
            Reject
          </button>
        </>
      )}
    </div>
  );
}

const User = () => (
  <div data-testid="message">
    <MessagePrimitive.Parts />
  </div>
);
const Assistant = () => (
  <div data-testid="message">
    <MessagePrimitive.Parts components={{ tools: { Fallback: Tool } }} />
  </div>
);

function App(options: SessionRuntimeOptions) {
  const runtime = useSessionRuntime(options);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages
            components={{ UserMessage: User, AssistantMessage: Assistant }}
          />
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input aria-label="Message" />
          <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
          <ComposerPrimitive.Cancel>Stop</ComposerPrimitive.Cancel>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

const question: ChatUiMessage = {
  id: 'item_1',
  role: 'user',
  parts: [{ type: 'text', text: 'restart payments' }],
};
const waiting: ChatUiMessage = {
  id: 'run_1',
  role: 'assistant',
  parts: [
    {
      type: 'tool-dev-actions:restart-service',
      toolCallId: 'c1',
      state: 'approval-requested',
      input: { name: 'payments' },
      approval: { id: 'a1' },
    } as unknown as ChatUiMessage['parts'][number],
  ],
};

describe('useSessionRuntime', () => {
  it('sends the text of the box when no run goes on', async () => {
    const onSend = jest.fn();
    render(<App messages={[]} isRunning={false} onSend={onSend} />);
    await userEvent.type(screen.getByLabelText('Message'), '  hello  ');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello'));
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('puts the text back when the message was not sent', async () => {
    const onSend = jest.fn().mockResolvedValue(false);
    render(<App messages={[]} isRunning={false} onSend={onSend} />);
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}');
    await waitFor(() =>
      expect(screen.getByLabelText('Message')).toHaveValue('hello'),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while sending is off, and keeps the text', async () => {
    const onSend = jest.fn();
    render(
      <App messages={[]} isRunning={false} isSendDisabled onSend={onSend} />,
    );
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('while a run goes on: no send, and Stop stops the run', async () => {
    const onSend = jest.fn();
    const onStop = jest.fn();
    render(
      <App messages={[question]} isRunning onSend={onSend} onStop={onStop} />,
    );
    await userEvent.type(screen.getByLabelText('Message'), 'more{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });

  it('has no Stop without a handler', () => {
    render(<App messages={[question]} isRunning onSend={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('passes the decision on with the id of the call', async () => {
    const onDecide = jest.fn();
    const { rerender } = render(
      <App
        messages={[question, waiting]}
        isRunning
        onSend={jest.fn()}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByTestId('call')).toHaveTextContent(
      'dev-actions:restart-service',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('c1', true));

    rerender(
      <App
        messages={[question, waiting]}
        isRunning
        onSend={jest.fn()}
        onDecide={onDecide}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('c1', false));
  });
});

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
  useAui,
  useAuiState,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import type { ChatUiMessage } from '../../domain/types';
import { createQueueAdapter, type SessionQueueSource } from './queueAdapter';
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
        <QueueButton />
        <AddImage />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function QueueButton() {
  const aui = useAui();
  return (
    <button onClick={() => aui.composer.send({ steer: false })}>Queue</button>
  );
}

const dot = new File([new Uint8Array(4)], 'dot.png', { type: 'image/png' });
const uploaded = {
  id: 'att-1',
  mediaType: 'image/png',
  name: 'dot.png',
  size: 4,
};

/** Adds `dot.png` as a paste or a drop would, and shows the images of the box. */
function AddImage() {
  const aui = useAui();
  const images = useAuiState(s =>
    s.composer.attachments.map(a => `${a.name}:${a.status.type}`).join(','),
  );
  const canAttach = useAuiState(s => s.thread.capabilities.attachments);
  return (
    <>
      <button onClick={() => aui.composer.addAttachment(dot).catch(() => {})}>
        Add image
      </button>
      <output aria-label="Images">{images}</output>
      <output aria-label="Can attach">{String(canAttach)}</output>
    </>
  );
}

const limits = {
  mediaTypes: ['image/png'],
  maxPerMessage: 4,
  maxBytes: 1000,
};

function queueSource(
  overrides: Partial<SessionQueueSource> = {},
): SessionQueueSource {
  return {
    queued: [],
    inserted: [],
    send: jest.fn().mockResolvedValue(true),
    queueMessage: jest.fn().mockResolvedValue(true),
    editQueued: jest.fn().mockResolvedValue(true),
    removeQueued: jest.fn().mockResolvedValue(undefined),
    moveQueued: jest.fn().mockResolvedValue(undefined),
    insertQueued: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
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
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ text: 'hello' }));
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

  describe('with the queue of the session', () => {
    it('keeps the box usable while a run goes on: Enter steers, send without steer enqueues, onSend is not used', async () => {
      const source = queueSource();
      const onSend = jest.fn();
      render(
        <App
          messages={[question]}
          isRunning
          onSend={onSend}
          queue={createQueueAdapter(source)}
        />,
      );
      await userEvent.type(screen.getByLabelText('Message'), 'more{Enter}');
      await waitFor(() =>
        expect(source.send).toHaveBeenCalledWith({ text: 'more' }),
      );
      expect(screen.getByLabelText('Message')).toHaveValue('');

      await userEvent.type(screen.getByLabelText('Message'), 'later');
      await userEvent.click(screen.getByRole('button', { name: 'Queue' }));
      await waitFor(() =>
        expect(source.queueMessage).toHaveBeenCalledWith({ text: 'later' }),
      );
      expect(onSend).not.toHaveBeenCalled();
    });

    it('sends through the queue when no run goes on as well', async () => {
      const source = queueSource();
      const onSend = jest.fn();
      render(
        <App
          messages={[]}
          isRunning={false}
          onSend={onSend}
          queue={createQueueAdapter(source)}
        />,
      );
      await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}');
      await waitFor(() =>
        expect(source.queueMessage).toHaveBeenCalledWith({ text: 'hello' }),
      );
      expect(onSend).not.toHaveBeenCalled();
    });

    it('puts the text back when the queue did not take the message', async () => {
      const source = queueSource({ send: jest.fn().mockResolvedValue(false) });
      render(
        <App
          messages={[question]}
          isRunning
          onSend={jest.fn()}
          queue={createQueueAdapter(source)}
        />,
      );
      await userEvent.type(screen.getByLabelText('Message'), 'keep me{Enter}');
      await waitFor(() =>
        expect(screen.getByLabelText('Message')).toHaveValue('keep me'),
      );
    });
  });

  describe('with images', () => {
    it('has no attachments without the uploads: the model reads no images', async () => {
      render(<App messages={[]} isRunning={false} onSend={jest.fn()} />);
      expect(screen.getByLabelText('Can attach')).toHaveTextContent('false');
      await userEvent.click(screen.getByText('Add image'));
      expect(screen.getByLabelText('Images')).toHaveTextContent('');
    });

    it('uploads an added image and sends its id with the message, also with no text', async () => {
      const upload = jest.fn().mockResolvedValue(uploaded);
      const onSend = jest.fn();
      render(
        <App
          messages={[]}
          isRunning={false}
          onSend={onSend}
          attachments={{ limits, upload }}
        />,
      );
      expect(screen.getByLabelText('Can attach')).toHaveTextContent('true');
      await userEvent.click(screen.getByText('Add image'));
      await waitFor(() =>
        expect(screen.getByLabelText('Images')).toHaveTextContent(
          'dot.png:complete',
        ),
      );
      expect(upload).toHaveBeenCalledWith(dot);
      await userEvent.click(screen.getByText('Send'));
      await waitFor(() =>
        expect(onSend).toHaveBeenCalledWith({
          text: '',
          attachments: [uploaded],
        }),
      );
      expect(screen.getByLabelText('Images')).toHaveTextContent('');
    });

    it('inserts and queues the images through the queue, and adds no message to the thread', async () => {
      const source = queueSource();
      render(
        <App
          messages={[question]}
          isRunning
          onSend={jest.fn()}
          queue={createQueueAdapter(source)}
          attachments={{
            limits,
            upload: jest.fn().mockResolvedValue(uploaded),
          }}
        />,
      );
      await userEvent.click(screen.getByText('Add image'));
      await userEvent.type(screen.getByLabelText('Message'), 'look{Enter}');
      await waitFor(() =>
        expect(source.send).toHaveBeenCalledWith({
          text: 'look',
          attachments: [uploaded],
        }),
      );
      // The thread shows the question and the running answer only; the
      // queue shows the inserted and queued messages.
      expect(screen.getAllByTestId('message')).toHaveLength(2);
      await userEvent.click(screen.getByText('Add image'));
      await waitFor(() =>
        expect(screen.getByLabelText('Images')).toHaveTextContent('complete'),
      );
      await userEvent.click(screen.getByText('Queue'));
      await waitFor(() =>
        expect(source.queueMessage).toHaveBeenCalledWith({
          text: '',
          attachments: [uploaded],
        }),
      );
      expect(screen.getAllByTestId('message')).toHaveLength(2);
    });

    it('puts the text and the image back when the queue did not take the message', async () => {
      const source = queueSource({ send: jest.fn().mockResolvedValue(false) });
      render(
        <App
          messages={[question]}
          isRunning
          onSend={jest.fn()}
          queue={createQueueAdapter(source)}
          attachments={{
            limits,
            upload: jest.fn().mockResolvedValue(uploaded),
          }}
        />,
      );
      await userEvent.click(screen.getByText('Add image'));
      await userEvent.type(screen.getByLabelText('Message'), 'keep me{Enter}');
      await waitFor(() => expect(source.send).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.getByLabelText('Message')).toHaveValue('keep me'),
      );
      expect(screen.getByLabelText('Images')).toHaveTextContent(
        'dot.png:complete',
      );
    });

    it('keeps the message in the box when an upload failed, and uploads nothing at send', async () => {
      const upload = jest.fn().mockRejectedValue(new Error('Too large'));
      const onSend = jest.fn();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      render(
        <App
          messages={[]}
          isRunning={false}
          onSend={onSend}
          attachments={{ limits, upload }}
        />,
      );
      await userEvent.click(screen.getByText('Add image'));
      await waitFor(() =>
        expect(screen.getByLabelText('Images')).toHaveTextContent(
          'dot.png:incomplete',
        ),
      );
      await userEvent.type(screen.getByLabelText('Message'), 'keep me');
      await userEvent.click(screen.getByText('Send'));
      await waitFor(() =>
        expect(screen.getByLabelText('Message')).toHaveValue('keep me'),
      );
      expect(screen.getByLabelText('Images')).toHaveTextContent(
        'dot.png:incomplete',
      );
      expect(onSend).not.toHaveBeenCalled();
      expect(upload).toHaveBeenCalledTimes(1);
    });
  });
});

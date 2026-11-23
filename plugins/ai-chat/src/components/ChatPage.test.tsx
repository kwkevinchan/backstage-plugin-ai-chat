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

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { aiChatApiRef } from '../api';
import type { ChatEvent } from '../common';
import { mockApi, pendingCall, readCall } from '../testData';
import { ChatPageContent } from './ChatPage';

async function* events(list: ChatEvent[], pause?: Promise<void>) {
  for (const event of list) {
    if (event.type === 'assistant_message' && pause) await pause;
    yield event;
  }
}

const userMessage = {
  id: 'm-1',
  role: 'user' as const,
  content: 'restart payments',
  createdAt: '2026-01-01T10:00:00.000Z',
};
const assistantMessage = {
  id: 'm-2',
  role: 'assistant' as const,
  content: 'I will restart it.',
  createdAt: '2026-01-01T10:00:01.000Z',
};

function renderPage(api: ReturnType<typeof mockApi>) {
  return renderInTestApp(
    <TestApiProvider apis={[[aiChatApiRef, api]]}>
      <ChatPageContent />
    </TestApiProvider>,
  );
}

describe('ChatPageContent', () => {
  it('lists the conversations and opens one with its tool calls', async () => {
    const api = mockApi({
      listConversations: jest.fn().mockResolvedValue([
        {
          id: 'c-9',
          title: 'Earlier chat',
          createdAt: '2026-01-01T09:00:00.000Z',
          updatedAt: '2026-01-01T09:00:00.000Z',
        },
      ]),
      getConversation: jest.fn().mockResolvedValue({
        conversation: { id: 'c-9', title: 'Earlier chat' },
        messages: [userMessage, assistantMessage],
        toolCalls: [readCall, pendingCall],
      }),
    });
    await renderPage(api);

    await userEvent.click(await screen.findByText('Earlier chat'));

    expect(await screen.findByText('I will restart it.')).toBeInTheDocument();
    expect(api.getConversation).toHaveBeenCalledWith('c-9');
    // The read-only call is a compact row; the other waits as a card.
    expect(screen.getByText('List services')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Approval: Restart a service' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'An action waits for your decision. A new message rejects it.',
      ),
    ).toBeInTheDocument();
  });

  it('creates a conversation on the first message and shows the streamed answer', async () => {
    let release: () => void = () => {};
    const pause = new Promise<void>(r => (release = r));
    const api = mockApi();
    api.sendMessage.mockReturnValue(
      events(
        [
          { type: 'user_message', message: userMessage },
          { type: 'text_delta', text: 'Hello ' },
          { type: 'text_delta', text: '**there**' },
          {
            type: 'assistant_message',
            message: { ...assistantMessage, content: 'Hello **there**' },
          },
          { type: 'done' },
        ],
        pause,
      ),
    );
    await renderPage(api);

    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');

    expect(api.createConversation).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(
        'c-1',
        'hi',
        expect.any(AbortSignal),
      ),
    );
    // The text shows while the answer is still being written.
    expect(await screen.findByText('there')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    release();
    await waitFor(() =>
      expect(screen.getByLabelText('Message')).toHaveValue(''),
    );
    expect(screen.getByText('there').tagName).toBe('STRONG');
    // The conversation that was just made is not read again.
    expect(api.getConversation).not.toHaveBeenCalled();
  });

  it('asks for approval, then allows it: the Allow button calls the approve route', async () => {
    const api = mockApi();
    api.sendMessage.mockReturnValue(
      events([
        { type: 'user_message', message: userMessage },
        { type: 'assistant_message', message: assistantMessage },
        { type: 'approval_required', toolCall: pendingCall },
        { type: 'done' },
      ]),
    );
    api.approveToolCall.mockReturnValue(
      events([
        {
          type: 'tool_call',
          toolCall: {
            ...pendingCall,
            status: 'approved',
            decidedBy: 'user:default/guest',
          },
        },
        {
          type: 'tool_result',
          toolCall: {
            ...pendingCall,
            status: 'succeeded',
            decidedBy: 'user:default/guest',
            decidedAt: '2026-01-01T10:05:00.000Z',
            output: { statusUrl: 'https://example.test/payments' },
          },
        },
        {
          type: 'assistant_message',
          message: { ...assistantMessage, id: 'm-3', content: 'Restarted.' },
        },
        { type: 'done' },
      ]),
    );
    await renderPage(api);
    await userEvent.type(
      screen.getByLabelText('Message'),
      'restart payments{Enter}',
    );

    const allow = await screen.findByRole('button', { name: 'Allow' });
    expect(api.approveToolCall).not.toHaveBeenCalled();
    await userEvent.click(allow);

    expect(api.approveToolCall).toHaveBeenCalledWith(
      'c-1',
      'call-1',
      expect.any(AbortSignal),
    );
    expect(api.rejectToolCall).not.toHaveBeenCalled();
    expect(await screen.findByText('Restarted.')).toBeInTheDocument();
    expect(
      screen.getByText(/Allowed by user:default\/guest at /),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('calls the reject route from the Reject button', async () => {
    const api = mockApi();
    api.sendMessage.mockReturnValue(
      events([
        { type: 'user_message', message: userMessage },
        { type: 'assistant_message', message: assistantMessage },
        { type: 'approval_required', toolCall: pendingCall },
        { type: 'done' },
      ]),
    );
    api.rejectToolCall.mockReturnValue(
      events([
        {
          type: 'tool_result',
          toolCall: {
            ...pendingCall,
            status: 'rejected',
            decidedBy: 'user:default/guest',
          },
        },
        { type: 'done' },
      ]),
    );
    await renderPage(api);
    await userEvent.type(
      screen.getByLabelText('Message'),
      'restart payments{Enter}',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reject' }),
    );
    expect(api.rejectToolCall).toHaveBeenCalledWith(
      'c-1',
      'call-1',
      expect.any(AbortSignal),
    );
    expect(api.approveToolCall).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Rejected by user:default\/guest/),
    ).toBeInTheDocument();
  });

  it('shows an error of the stream, and of a refused request', async () => {
    const api = mockApi();
    api.sendMessage.mockReturnValueOnce(
      events([
        { type: 'user_message', message: userMessage },
        { type: 'error', message: 'The model server answered 500' },
        { type: 'done' },
      ]),
    );
    await renderPage(api);
    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model server answered 500',
    );
  });

  it('reads the conversation again after an error event, and keeps the error', async () => {
    const api = mockApi({
      getConversation: jest.fn().mockResolvedValue({
        conversation: { id: 'c-1', title: 'x' },
        messages: [userMessage, assistantMessage],
        toolCalls: [
          {
            ...pendingCall,
            status: 'rejected',
            error: 'superseded',
            decidedBy: 'user:default/guest',
          },
        ],
      }),
    });
    api.sendMessage.mockReturnValue(
      events([
        { type: 'user_message', message: userMessage },
        { type: 'error', message: 'The chat failed.' },
        { type: 'done' },
      ]),
    );
    await renderPage(api);
    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');
    await waitFor(() =>
      expect(api.getConversation).toHaveBeenCalledWith('c-1'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The chat failed.',
    );
    // The stored state (a decision of another tab) is on the screen.
    expect(
      await screen.findByText(/Not decided: a new message/),
    ).toBeInTheDocument();
  });

  it('reads the conversation again after a refused approval (409)', async () => {
    const api = mockApi();
    api.sendMessage.mockReturnValue(
      events([
        { type: 'user_message', message: userMessage },
        { type: 'assistant_message', message: assistantMessage },
        { type: 'approval_required', toolCall: pendingCall },
        { type: 'done' },
      ]),
    );
    // eslint-disable-next-line require-yield
    api.approveToolCall.mockImplementation(async function* refused() {
      throw Object.assign(new Error('Request failed with 409 Conflict'), {
        cause: new Error('This call is not waiting for a decision'),
      });
    });
    api.getConversation.mockResolvedValue({
      conversation: { id: 'c-1', title: 'x' } as any,
      messages: [userMessage, assistantMessage],
      toolCalls: [
        {
          ...pendingCall,
          status: 'succeeded',
          decidedBy: 'user:default/guest',
        },
      ],
    });
    await renderPage(api);
    await userEvent.type(screen.getByLabelText('Message'), 'restart{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(
      await screen.findByText(/Allowed by user:default\/guest/),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This call is not waiting for a decision',
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('deletes a conversation', async () => {
    const api = mockApi({
      listConversations: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'c-9',
            title: 'Earlier chat',
            createdAt: '',
            updatedAt: '',
          },
        ])
        .mockResolvedValue([]),
    });
    await renderPage(api);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Delete conversation Earlier chat',
      }),
    );
    expect(api.deleteConversation).toHaveBeenCalledWith('c-9');
    await waitFor(() => expect(screen.queryByText('Earlier chat')).toBeNull());
  });
});

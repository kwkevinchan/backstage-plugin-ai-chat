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

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pendingCall, readCall } from '../testData';
import { ApprovalCard, ToolCallRow } from './ToolCallView';

describe('ApprovalCard', () => {
  it('shows the action, its description, the badge and the exact input', () => {
    render(
      <ApprovalCard
        toolCall={pendingCall}
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByText('Restart a service')).toBeInTheDocument();
    expect(screen.getByText('dev-actions:restart-service')).toBeInTheDocument();
    expect(
      screen.getByText('Restarts one of the example services.'),
    ).toBeInTheDocument();
    expect(screen.getByText('destructive')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    const input = screen.getByText(/"name": "payments"/);
    expect(input.textContent).toBe(
      JSON.stringify({ name: 'payments', force: true }, null, 2),
    );
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('has no destructive badge for an action that is not destructive', () => {
    render(
      <ApprovalCard
        toolCall={{
          ...pendingCall,
          attributes: { ...pendingCall.attributes, destructive: false },
        }}
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.queryByText('destructive')).toBeNull();
  });

  it('calls the handlers with the call, once for each click', async () => {
    const onApprove = jest.fn();
    const onReject = jest.fn();
    render(
      <ApprovalCard
        toolCall={pendingCall}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(pendingCall);
    expect(onReject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith(pendingCall);
  });

  it('disables the buttons while a decision is being sent', () => {
    render(
      <ApprovalCard
        toolCall={pendingCall}
        disabled
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('shows who decided and when, and no buttons, after the decision', () => {
    render(
      <ApprovalCard
        toolCall={{
          ...pendingCall,
          status: 'succeeded',
          output: { statusUrl: 'https://example.test/s' },
          decidedBy: 'user:default/guest',
          decidedAt: '2026-01-01T10:05:00.000Z',
        }}
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(
      screen.getByText(/Allowed by user:default\/guest at /),
    ).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    // The result has a link that can be opened.
    expect(
      screen.getByRole('link', { name: 'https://example.test/s' }),
    ).toHaveAttribute('href', 'https://example.test/s');
  });

  it('says that a rejected call did not run, and why a superseded one did not', () => {
    const { rerender } = render(
      <ApprovalCard
        toolCall={{
          ...pendingCall,
          status: 'rejected',
          decidedBy: 'user:default/guest',
          decidedAt: '2026-01-01T10:05:00.000Z',
        }}
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(
      screen.getByText(/Rejected by user:default\/guest at /),
    ).toBeInTheDocument();
    rerender(
      <ApprovalCard
        toolCall={{
          ...pendingCall,
          status: 'rejected',
          error: 'superseded',
          decidedBy: 'user:default/guest',
        }}
        onApprove={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByText(/Not decided: a new message/)).toBeInTheDocument();
  });
});

describe('ToolCallRow', () => {
  it('is a compact row with the input and output folded, and clickable links', async () => {
    render(<ToolCallRow toolCall={readCall} />);
    expect(screen.getByText('List services')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://example.test/payments' }),
    ).toHaveAttribute('href', 'https://example.test/payments');
  });

  it('shows the error of a failed call and says that an output was cut', () => {
    render(
      <ToolCallRow
        toolCall={{
          ...readCall,
          status: 'failed',
          error: 'There is no tool named nope',
          output: { truncated: true, originalLength: 5000, text: '{"a":' },
        }}
      />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('There is no tool named nope')).toBeInTheDocument();
    expect(
      screen.getByText('Output (cut: the first part of 5000 characters)'),
    ).toBeInTheDocument();
  });
});

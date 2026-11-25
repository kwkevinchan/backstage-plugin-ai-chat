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
import { toToolCall } from '../adapters/assistantUi/toThreadMessage';
import { statusOfTool } from '../domain/toolView';
import type { ToolPart } from '../domain/types';
import {
  ApprovalCard,
  formatJson,
  hasInvisibleCharacters,
  needsCard,
  statusOfCall,
  ToolCallRow,
  type ToolCallProps,
} from './ToolCallCard';

const base = {
  type: 'tool-dev-actions:restart-service',
  toolCallId: 'c1',
  input: { name: 'payments', force: true },
};
const part = (extra: object) => ({ ...base, ...extra } as unknown as ToolPart);
const waiting = part({ state: 'approval-requested', approval: { id: 'c1' } });

/** The props that the tool component gets for a part, through the adapter. */
const callOf = (
  p: ToolPart,
  respondToApproval = jest.fn().mockResolvedValue(undefined),
) => ({ ...toToolCall(p), respondToApproval } as unknown as ToolCallProps);

describe('ApprovalCard', () => {
  it('shows the action, the status and the exact input', () => {
    render(<ApprovalCard call={callOf(waiting)} />);
    expect(screen.getByText('Restart service')).toBeInTheDocument();
    expect(screen.getByText('dev-actions:restart-service')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText(/"name": "payments"/).textContent).toBe(
      JSON.stringify({ name: 'payments', force: true }, null, 2),
    );
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('shows the title and the description of the tool, and why it asks', () => {
    const tool = {
      id: 'dev-actions:restart-service',
      title: 'Restart a service',
      description: 'Restarts one of the example services.',
      readOnly: false,
    };
    const { rerender } = render(
      <ApprovalCard call={callOf(waiting)} tool={tool} />,
    );
    expect(screen.getByText('Restart a service')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Approval: Restart a service' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Restarts one of the example services.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /This action changes something. It runs only after you approve/,
      ),
    ).toBeInTheDocument();

    rerender(
      <ApprovalCard
        call={callOf(waiting)}
        tool={{ ...tool, readOnly: true }}
      />,
    );
    expect(
      screen.getByText(/policy of your administrator asks/),
    ).toBeInTheDocument();
  });

  it('says nothing about why it asks when the tool is not known', () => {
    render(<ApprovalCard call={callOf(waiting)} />);
    expect(screen.queryByText(/changes something/)).toBeNull();
    expect(screen.queryByText(/policy of your administrator/)).toBeNull();
  });

  it('shows who decided and when, when the log says', () => {
    render(
      <ApprovalCard
        call={callOf(
          part({
            state: 'output-available',
            output: 1,
            approval: { id: 'c1', approved: true },
          }),
        )}
        decision={{ by: 'user:default/guest', at: '2026-01-01T10:00:00.000Z' }}
      />,
    );
    expect(
      screen.getByText(
        `Allowed by user:default/guest at ${new Date(
          '2026-01-01T10:00:00.000Z',
        ).toLocaleString()}.`,
      ),
    ).toBeInTheDocument();
  });

  it('answers the approval through the props of the tool component', async () => {
    const respond = jest.fn().mockResolvedValue(undefined);
    render(<ApprovalCard call={callOf(waiting, respond)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(respond.mock.calls).toEqual([
      [{ approved: true }],
      [{ approved: false }],
    ]);
  });

  it('keeps working when the runtime refuses a decision, also with a throw', async () => {
    const throws = jest.fn(() => {
      throw new Error('decided already');
    });
    const rejects = jest.fn().mockRejectedValue(new Error('decided already'));
    const { rerender } = render(
      <ApprovalCard call={callOf(waiting, throws)} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(throws).toHaveBeenCalledTimes(1);
    rerender(<ApprovalCard call={callOf(waiting, rejects)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(rejects).toHaveBeenCalledWith({ approved: false });
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });

  it('disables the buttons while a decision is being sent', () => {
    render(<ApprovalCard call={callOf(waiting)} disabled />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('shows what was decided, and no buttons, after the decision', () => {
    render(
      <ApprovalCard
        call={callOf(
          part({
            state: 'output-available',
            output: { ok: true },
            approval: { id: 'c1', approved: true },
          }),
        )}
      />,
    );
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Allowed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('says that a rejected call did not run', () => {
    render(
      <ApprovalCard
        call={callOf(
          part({
            state: 'output-denied',
            approval: { id: 'c1', approved: false },
          }),
        )}
      />,
    );
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.getByText('Denied.')).toBeInTheDocument();
  });

  it('shows a call that was allowed and has no result yet', () => {
    render(
      <ApprovalCard
        call={callOf(
          part({
            state: 'approval-responded',
            approval: { id: 'c1', approved: true },
          }),
        )}
      />,
    );
    expect(
      screen.getByText('Allowed', { selector: 'span' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('shows the result unknown, and the call that did not run, with a reason', () => {
    const { rerender } = render(
      <ApprovalCard
        call={callOf(
          part({
            state: 'output-error',
            errorText: 'The result of the call is not known.',
            approval: { id: 'c1', approved: true },
          }),
        )}
      />,
    );
    expect(screen.getByText('Result unknown')).toBeInTheDocument();
    expect(
      screen.getByText(/The call may have run, but its result was not stored/),
    ).toBeInTheDocument();

    rerender(
      <ApprovalCard
        call={callOf(
          part({
            state: 'output-error',
            errorText: 'The call did not run.',
          }),
        )}
      />,
    );
    expect(screen.getByText('Did not run')).toBeInTheDocument();
    expect(
      screen.getByText('The run ended before the call ran.'),
    ).toBeInTheDocument();
  });
});

describe('statusOfCall', () => {
  it.each([
    ['input-streaming', {}],
    ['input-available', {}],
    ['approval-requested', { approval: { id: 'c1' } }],
    ['approval-responded', { approval: { id: 'c1', approved: true } }],
    ['approval-responded', { approval: { id: 'c1', approved: false } }],
    ['output-available', { output: { ok: true } }],
    [
      'output-available',
      { output: { ok: true }, approval: { id: 'c1', approved: true } },
    ],
    ['output-denied', { approval: { id: 'c1', approved: false } }],
    ['output-error', { errorText: 'boom' }],
    ['output-error', { errorText: 'The result of the call is not known.' }],
    ['output-error', { errorText: 'The call did not run.' }],
  ])(
    'reads %s %j from the props as the domain reads the part',
    (state, extra) => {
      const p = part({ state, ...extra });
      expect(statusOfCall(toToolCall(p))).toBe(statusOfTool(p));
    },
  );
});

describe('needsCard', () => {
  it('is true for a call that waited for a decision or got one', () => {
    expect(needsCard(toToolCall(waiting))).toBe(true);
    expect(
      needsCard(
        toToolCall(
          part({
            state: 'output-denied',
            approval: { id: 'c1', approved: false },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      needsCard(
        toToolCall(
          part({
            state: 'output-available',
            output: 1,
            approval: { id: 'c1', approved: true },
          }),
        ),
      ),
    ).toBe(true);
  });
  it('is false for a call that ran without asking', () => {
    expect(
      needsCard(toToolCall(part({ state: 'output-available', output: 1 }))),
    ).toBe(false);
    expect(needsCard(toToolCall(part({ state: 'input-available' })))).toBe(
      false,
    );
  });
});

describe('invisible characters in the input', () => {
  const tricky = part({
    state: 'approval-requested',
    approval: { id: 'c1' },
    input: { name: 'pay\u200Bments', note: 'a\u202Eb', tag: '\u{E0041}' },
  });

  it('are shown as escapes, with a warning line', () => {
    render(<ApprovalCard call={callOf(tricky)} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The input has invisible characters',
    );
    const shown = screen.getByText(/"name": "pay/).textContent!;
    expect(shown).toContain('pay\\u200Bments');
    expect(shown).toContain('a\\u202Eb');
    expect(shown).toContain('\\u{E0041}');
    expect(shown).not.toContain('\u200B');
    expect(shown).not.toContain('\u202E');
  });

  it('have no warning when the input is plain, also with a line break', () => {
    render(
      <ApprovalCard
        call={callOf(
          part({
            state: 'approval-requested',
            approval: { id: 'c1' },
            input: { text: 'a\nb' },
          }),
        )}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['\u2028', '\\u2028'],
    ['\u2029', '\\u2029'],
    ['\u3164', '\\u3164'],
    ['\u115F', '\\u115F'],
    ['\u1160', '\\u1160'],
    ['\uFFA0', '\\uFFA0'],
  ])('include the look-alike blank %j', (char, escaped) => {
    expect(hasInvisibleCharacters({ name: `a${char}b` })).toBe(true);
    expect(formatJson({ name: `a${char}b` })).toContain(`a${escaped}b`);
    expect(formatJson({ name: `a${char}b` })).not.toContain(char);
  });

  it('are found in keys and nested values, and escaped in the output too', () => {
    expect(hasInvisibleCharacters({ a: [{ 'k\u200B': 1 }] })).toBe(true);
    expect(hasInvisibleCharacters({ a: ['x\u0007'] })).toBe(true);
    expect(hasInvisibleCharacters({ a: ['x'] })).toBe(false);
    expect(formatJson({ a: 'x\u2066' })).toContain('x\\u2066');
  });
});

describe('ToolCallRow', () => {
  const read = part({
    type: 'tool-dev-actions:list-services',
    state: 'output-available',
    input: {},
    output: {
      services: [
        { name: 'payments', statusUrl: 'https://example.test/payments' },
      ],
    },
  });

  it('is a compact row with the input and output folded, and clickable links', () => {
    const { container } = render(<ToolCallRow call={callOf(read)} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('List services')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://example.test/payments' }),
    ).toHaveAttribute('href', 'https://example.test/payments');
  });

  it('shows the error of a failed call', () => {
    render(
      <ToolCallRow
        call={callOf(
          part({
            state: 'output-error',
            errorText: 'There is no tool named nope',
          }),
        )}
      />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('There is no tool named nope')).toBeInTheDocument();
  });

  it('says that an output was cut', () => {
    render(
      <ToolCallRow
        call={callOf(
          part({
            state: 'output-available',
            output: { truncated: true, originalLength: 5000, text: '{"a":' },
          }),
        )}
      />,
    );
    expect(
      screen.getByText('Output (cut: the first part of 5000 characters)'),
    ).toBeInTheDocument();
  });
});

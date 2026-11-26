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

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AiChatToolResultProps,
  AiChatToolResultsApi,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { createAiChatToolResultsApi } from '../application/toolResultsApi';
import type { ChatUiMessage } from '../domain/types';
import { RESULT_NOT_KNOWN } from '../domain/toolView';
import {
  assistantText,
  renderThread,
  ThreadHarness,
} from './__testUtils__/renderThread';

const ACTION = 'example:list-services';

const received: AiChatToolResultProps[] = [];

function ServicesTable(props: AiChatToolResultProps) {
  received.push(props);
  const services =
    (props.output as { services?: { name: string }[] } | undefined)?.services ??
    [];
  return (
    <div>
      <span>Status {props.status}</span>
      {props.errorText && <span>Error {props.errorText}</span>}
      <ul aria-label="Services">
        {services.map(service => (
          <li key={service.name}>{service.name}</li>
        ))}
      </ul>
    </div>
  );
}

function Throws(): JSX.Element {
  throw new Error('the component broke');
}

function call(
  part: Record<string, unknown>,
  toolId = ACTION,
  id = 'run_1',
): ChatUiMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: `tool-${toolId}`,
        toolCallId: 'c1',
        input: { team: 'payments' },
        ...part,
      } as never,
    ],
  };
}

const done = call({
  state: 'output-available',
  output: { services: [{ name: 'payments' }, { name: 'search' }] },
});

function withResults(toolResults: AiChatToolResultsApi) {
  return { list: { toolResults } };
}

const registered = () =>
  createAiChatToolResultsApi([{ actionId: ACTION, component: ServicesTable }]);

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  received.length = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('the result component of an action', () => {
  it('shows the registered component with the action id, the input and the output', () => {
    renderThread([done], withResults(registered()));
    const result = screen.getByRole('group', { name: 'Result: List services' });
    expect(
      within(result)
        .getAllByRole('listitem')
        .map(item => item.textContent),
    ).toEqual(['payments', 'search']);
    expect(received.at(-1)).toEqual({
      actionId: ACTION,
      input: { team: 'payments' },
      status: 'complete',
      output: { services: [{ name: 'payments' }, { name: 'search' }] },
      errorText: undefined,
    });
  });

  it('keeps the row of the call above it, with its status and the raw output', async () => {
    renderThread([done], withResults(registered()));
    const row = screen.getByText('List services').closest('details')!;
    expect(within(row).getByText('Done')).toBeInTheDocument();
    await userEvent.click(within(row).getByText('List services'));
    expect(within(row).getByText(/"name": "payments"/)).toBeVisible();
  });

  it('shows the default view for an action without a component', () => {
    renderThread(
      [call({ state: 'output-available', output: { ok: true } }, 'other:x')],
      withResults(registered()),
    );
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('other:x')).toBeInTheDocument();
    expect(received).toEqual([]);
  });

  it('shows the default view when the chat has no result components', () => {
    renderThread([done]);
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('List services')).toBeInTheDocument();
  });

  it('falls back to the default view when the component throws, and the conversation stays', () => {
    const api = createAiChatToolResultsApi([
      { actionId: ACTION, component: Throws },
    ]);
    renderThread([done, assistantText('After the call.', 'run_2')], {
      list: { toolResults: api },
    });
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('List services')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('After the call.')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`result component for ${ACTION} failed`),
      expect.any(Error),
      expect.anything(),
    );
  });

  it('tries the component again when the status changes after it threw', () => {
    function ThrowsWhileRunning(props: AiChatToolResultProps) {
      if (props.status === 'running') throw new Error('no output yet');
      return <span>Shown when {props.status}</span>;
    }
    const toolResults = createAiChatToolResultsApi([
      { actionId: ACTION, component: ThrowsWhileRunning },
    ]);
    const view = renderThread([call({ state: 'input-available' })], {
      list: { toolResults },
    });
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();

    view.rerender(
      <ThreadHarness messages={[done]} options={{ list: { toolResults } }} />,
    );
    expect(screen.getByText('Shown when complete')).toBeInTheDocument();
  });

  it.each([
    ['a call that runs', { state: 'input-available' }, 'running', undefined],
    [
      'a failed call',
      { state: 'output-error', errorText: 'The service is down.' },
      'failed',
      'The service is down.',
    ],
    [
      'a call with an unknown result',
      { state: 'output-error', errorText: RESULT_NOT_KNOWN },
      'unknown',
      RESULT_NOT_KNOWN,
    ],
    [
      'a denied call',
      { state: 'output-denied', approval: { id: 'c1', approved: false } },
      'denied',
      undefined,
    ],
    [
      'an allowed call without a result',
      { state: 'approval-responded', approval: { id: 'c1', approved: true } },
      'running',
      undefined,
    ],
  ])('passes the status of %s', (_, part, status, errorText) => {
    renderThread([call(part)], withResults(registered()));
    expect(screen.getByText(`Status ${status}`)).toBeInTheDocument();
    expect(received.at(-1)).toMatchObject({
      status,
      errorText,
      output: undefined,
    });
  });

  it('does not draw a call that did not run', () => {
    renderThread(
      [call({ state: 'output-error', errorText: 'The call did not run.' })],
      withResults(registered()),
    );
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Did not run')).toBeInTheDocument();
  });
});

describe('the approval card with a result component', () => {
  it('is not replaced while the call waits: the component is not drawn', () => {
    renderThread(
      [call({ state: 'approval-requested', approval: { id: 'c1' } })],
      withResults(registered()),
    );
    const card = screen.getByRole('region', {
      name: 'Approval: List services',
    });
    expect(within(card).getByText('Waiting for approval')).toBeInTheDocument();
    expect(within(card).getByText(/"team": "payments"/)).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Allow' }),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Deny' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(received).toEqual([]);
  });

  it('keeps the card and who decided after the decision, with the component under it', () => {
    renderThread(
      [
        call({
          state: 'output-available',
          output: { services: [{ name: 'payments' }] },
          approval: { id: 'c1', approved: true },
        }),
      ],
      {
        list: {
          toolResults: registered(),
          decisions: {
            c1: { by: 'user:default/guest', at: '2026-11-26T10:00:00Z' },
          },
        },
      },
    );
    const card = screen.getByRole('region', {
      name: 'Approval: List services',
    });
    expect(
      within(card).getByText(/Allowed by user:default\/guest at/),
    ).toBeInTheDocument();
    const result = screen.getByRole('group', { name: 'Result: List services' });
    expect(card.contains(result)).toBe(false);
    expect(within(result).getByText('payments')).toBeInTheDocument();
  });
});

describe('the tools of the core', () => {
  it('keep their own view even when an API returns a component for them', () => {
    const api: AiChatToolResultsApi = { getComponent: () => ServicesTable };
    renderThread(
      [
        call(
          {
            state: 'output-available',
            input: { items: [{ text: 'Check', status: 'pending' }] },
            output: 'Plan updated.',
          },
          'update_plan',
        ),
        call(
          { state: 'output-error', input: {}, errorText: 'Bad input.' },
          'update_plan',
          'run_2',
        ),
        call(
          { state: 'output-available', input: {}, output: 'Skill text' },
          'load_skill',
          'run_3',
        ),
      ],
      withResults(api),
    );
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /^Result:/ }),
    ).not.toBeInTheDocument();
    expect(received).toEqual([]);
  });
});

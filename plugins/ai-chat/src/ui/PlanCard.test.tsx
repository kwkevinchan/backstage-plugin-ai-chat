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
import { itemsToMessages } from '../domain/itemsToMessages';
import type { ChatUiMessage } from '../domain/types';
import { detail, items, user } from '../testData';
import { renderThread } from './__testUtils__/renderThread';

const plan = {
  items: [
    { text: 'Find the failed deployment', status: 'completed' },
    { text: 'Read its logs', status: 'in_progress' },
    { text: 'Restart the service', status: 'pending' },
  ],
};

function planCall(part: Record<string, unknown>): ChatUiMessage {
  return {
    id: 'run_1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-update_plan',
        toolCallId: 'c1',
        input: plan,
        ...part,
      } as never,
    ],
  };
}

describe('the plan of an update_plan call', () => {
  it('shows each step with its text and its status in words', () => {
    renderThread([
      planCall({ state: 'output-available', output: 'Plan updated.' }),
    ]);
    const list = screen.getByRole('region', { name: 'Plan' });
    expect(within(list).getByText('1 of 3 done')).toBeInTheDocument();
    const steps = within(list).getAllByRole('listitem');
    expect(steps.map(step => step.textContent)).toEqual([
      '✓Find the failed deploymentDone',
      '→Read its logsIn progress',
      '○Restart the serviceTo do',
    ]);
    // The output of the call is not shown: the list is the result.
    expect(screen.queryByText('Plan updated.')).not.toBeInTheDocument();
  });

  it('shows a plan with no steps', () => {
    renderThread([
      planCall({
        state: 'output-available',
        input: { items: [] },
        output: 'Plan updated.',
      }),
    ]);
    const list = screen.getByRole('region', { name: 'Plan' });
    expect(within(list).getByText('No steps')).toBeInTheDocument();
    expect(within(list).queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the steps while the call runs', () => {
    renderThread([planCall({ state: 'input-available' })]);
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();
  });

  it('shows a refused call as any other call, with its error', () => {
    renderThread([
      planCall({
        state: 'output-error',
        input: { items: [{ text: 'a', status: 'done' }] },
        errorText: 'Item 1 of update_plan needs a "status".',
      }),
    ]);
    expect(
      screen.queryByRole('region', { name: 'Plan' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Update plan')).toBeInTheDocument();
  });

  it('shows the approval card while the call waits for a decision', () => {
    renderThread([
      planCall({ state: 'approval-requested', approval: { id: 'c1' } }),
    ]);
    expect(
      screen.queryByRole('region', { name: 'Plan' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  it('shows the same list from the stored items after a reload', () => {
    const messages = itemsToMessages(
      detail({
        items: items(
          user('plan the restart'),
          {
            kind: 'tool_call',
            callId: 'c1',
            toolId: 'update_plan',
            input: plan as never,
            schemaHash: 'builtin:update_plan:v1',
            policy: 'allow',
            readOnly: true,
            step: 1,
            position: 0,
          },
          { kind: 'plan_update', plan: plan as never },
          {
            kind: 'tool_result',
            callId: 'c1',
            status: 'ok',
            output: 'Plan updated.',
          },
          { kind: 'agent_message', text: 'The plan is written.' },
        ),
      }),
    );
    renderThread(messages);
    const list = screen.getByRole('region', { name: 'Plan' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Read its logs')).toBeInTheDocument();
    expect(screen.getByText('The plan is written.')).toBeInTheDocument();
  });

  it('leaves other tools to the usual row', () => {
    renderThread([
      {
        id: 'run_1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-dev-actions:list-services',
            toolCallId: 'c2',
            state: 'output-available',
            input: plan,
            output: { ok: true },
          } as never,
        ],
      },
    ]);
    expect(
      screen.queryByRole('region', { name: 'Plan' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('List services')).toBeInTheDocument();
  });
});

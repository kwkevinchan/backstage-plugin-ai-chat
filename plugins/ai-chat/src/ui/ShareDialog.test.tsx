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

import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatShare } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { answer, detail, items, mockApi, session, user } from '../testData';
import { SessionView } from './SessionView';

function renderView(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function shareFixture(overrides: Partial<ChatShare> = {}): ChatShare {
  return {
    id: 'sh-1',
    subjectRef: 'user:default/bob',
    mode: 'snapshot',
    upToSeq: 2,
    expired: false,
    createdBy: 'user:default/guest',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('SessionView sharing UI and fork (P2-05)', () => {
  it('shows SH-07 disclosure text, group warning, and creates/refreshes/stops shares', async () => {
    const existing = shareFixture();
    const refreshed = shareFixture({ upToSeq: 4 });
    const createdGroup = shareFixture({
      id: 'sh-2',
      subjectRef: 'group:default/sre',
      mode: 'snapshot',
    });
    const api = mockApi({
      listShares: jest.fn().mockResolvedValue([existing]),
      createShare: jest.fn().mockResolvedValue(createdGroup),
      updateShare: jest.fn().mockResolvedValue(refreshed),
      revokeShare: jest.fn().mockResolvedValue(undefined),
    });

    renderView(
      <SessionView
        api={api}
        detail={detail({ items: items(user('hi'), answer('hello')) })}
        toolsets={[]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = screen.getByRole('region', { name: 'Share conversation' });
    expect(dialog).toHaveTextContent(
      'Recipients will see tool outputs retrieved with your permissions.',
    );
    expect(dialog).toHaveTextContent(
      'Recipients can copy this conversation into their own session. Copied messages, plans, and images cannot be taken back.',
    );
    expect(
      screen.queryByText(/anyone who joins the group later/i),
    ).not.toBeInTheDocument();

    // Typing a group ref reveals the group membership warning (SH-07).
    await userEvent.type(
      screen.getByLabelText('Recipient'),
      'group:default/sre',
    );
    expect(
      screen.getByText(/anyone who joins the group later/i),
    ).toBeInTheDocument();

    // Create a share.
    await userEvent.click(screen.getByRole('button', { name: 'Create share' }));
    expect(api.createShare).toHaveBeenCalledWith(session.id, {
      subjectRef: 'group:default/sre',
      mode: 'snapshot',
      includeToolOutputs: true,
    });
    expect(await screen.findByText(/group:default\/sre/)).toBeInTheDocument();

    // Refresh existing snapshot share.
    const refreshButtons = screen.getAllByRole('button', { name: 'Refresh' });
    await userEvent.click(refreshButtons[0]);
    expect(api.updateShare).toHaveBeenCalledWith(session.id, 'sh-1', {
      refresh: true,
    });

    // Stop sharing removes it from the list.
    const stopButtons = screen.getAllByRole('button', { name: 'Stop sharing' });
    await userEvent.click(stopButtons[0]);
    expect(api.revokeShare).toHaveBeenCalledWith(session.id, 'sh-1');
    await waitFor(() =>
      expect(screen.queryByText(/user:default\/bob/)).not.toBeInTheDocument(),
    );
  });

  it('shows the live-sharing banner at the top for owners and stops live sharing on click (SH-10)', async () => {
    const liveShare = shareFixture({
      id: 'sh-live',
      subjectRef: 'user:default/carol',
      mode: 'live',
      upToSeq: undefined,
      expiresAt: '2026-01-02T10:00:00.000Z',
      expired: false,
    });
    const api = mockApi({
      listShares: jest.fn().mockResolvedValue([liveShare]),
      revokeShare: jest.fn().mockResolvedValue(undefined),
    });

    renderView(
      <SessionView
        api={api}
        detail={detail({ items: items(user('hi'), answer('hello')) })}
        toolsets={[]}
      />,
    );

    const banner = await screen.findByRole('status', { name: 'Live sharing' });
    expect(banner).toHaveTextContent('user:default/carol');

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Stop live sharing with user:default/carol',
      }),
    );
    expect(api.revokeShare).toHaveBeenCalledWith(session.id, 'sh-live');
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: 'Live sharing' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('renders read-only snapshot banner with timestamp, hides composer, and copies on click (SH-04, SH-12)', async () => {
    const forked = { ...session, id: 's-forked', ownerRef: 'user:default/bob' };
    const api = mockApi({
      forkSession: jest.fn().mockResolvedValue(forked),
    });
    const onForked = jest.fn();

    renderView(
      <SessionView
        api={api}
        detail={detail({
          items: items(user('question'), answer('reply')),
          shared: {
            mode: 'snapshot',
            snapshotAt: '2026-01-01T10:00:00.000Z',
          },
        })}
        toolsets={[]}
        onForked={onForked}
      />,
    );

    const banner = screen.getByRole('status', { name: 'Shared conversation' });
    expect(banner).toHaveTextContent('Shared snapshot');
    expect(banner).toHaveTextContent(
      new Date('2026-01-01T10:00:00.000Z').toLocaleString(),
    );
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Share' }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Copy to my sessions' }),
    );
    expect(api.forkSession).toHaveBeenCalledWith(session.id);
    await waitFor(() => expect(onForked).toHaveBeenCalledWith(forked));
  });

  it('renders read-only live banner for a live sharee (SH-12)', () => {
    const api = mockApi();

    renderView(
      <SessionView
        api={api}
        detail={detail({
          items: items(user('question'), answer('reply')),
          shared: {
            mode: 'live',
            expiresAt: '2026-01-02T10:00:00.000Z',
          },
        })}
        toolsets={[]}
      />,
    );

    const banner = screen.getByRole('status', { name: 'Shared conversation' });
    expect(banner).toHaveTextContent('Shared live conversation');
    expect(banner).toHaveTextContent(
      new Date('2026-01-02T10:00:00.000Z').toLocaleString(),
    );
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });
});

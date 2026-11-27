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

import type { Entity } from '@backstage/catalog-model';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { aiChatApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { mockApi, session } from '../testData';
import { EntityAiChatContentView } from './EntityAiChatContent';

const TEST_ENTITY: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'example-payments',
    namespace: 'default',
  },
  spec: {
    type: 'service',
    lifecycle: 'experimental',
    owner: 'guests',
  },
};

function LocationDisplay() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{`${pathname}${search}`}</div>;
}

async function renderEntityTab(
  api: ReturnType<typeof mockApi>,
  entity: Entity = TEST_ENTITY,
) {
  await renderInTestApp(
    <TestApiProvider apis={[[aiChatApiRef, api]]}>
      <EntityProvider entity={entity}>
        <EntityAiChatContentView />
        <LocationDisplay />
      </EntityProvider>
    </TestApiProvider>,
    {
      mountedRoutes: {
        '/ai-chat': rootRouteRef,
      },
    },
  );
  return {
    where: () => screen.getByTestId('location').textContent,
  };
}

describe('EntityAiChatContent', () => {
  it('lists sessions bound to the current entity with live status badges', async () => {
    const api = mockApi({
      listSessions: jest.fn().mockResolvedValue([
        {
          ...session,
          id: 's-1',
          title: 'Investigate payments latency',
          entityRef: 'component:default/example-payments',
          activity: 'running',
        },
        {
          ...session,
          id: 's-2',
          title: 'Restart payments',
          entityRef: 'component:default/example-payments',
          activity: 'waiting_approval',
        },
      ]),
    });

    await renderEntityTab(api);

    expect(
      await screen.findByText('Investigate payments latency'),
    ).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Restart payments')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(api.listSessions).toHaveBeenCalledWith({
      entityRef: 'component:default/example-payments',
    });
  });

  it('navigates to /ai-chat/:id when a session row is clicked', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      listSessions: jest.fn().mockResolvedValue([
        {
          ...session,
          id: 's-42',
          title: 'Payments incident',
          entityRef: 'component:default/example-payments',
        },
      ]),
    });

    const { where } = await renderEntityTab(api);

    await user.click(await screen.findByText('Payments incident'));
    await waitFor(() => expect(where()).toBe('/ai-chat/s-42'));
  });

  it('navigates to /ai-chat?entityRef=... when New chat is clicked', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      listSessions: jest.fn().mockResolvedValue([]),
    });

    const { where } = await renderEntityTab(api);

    await user.click(await screen.findByRole('button', { name: 'New chat' }));
    expect(where()).toBe(
      '/ai-chat?entityRef=component%3Adefault%2Fexample-payments',
    );
  });

  it('keeps entityRef filter when toggling Show archived', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      listSessions: jest.fn().mockResolvedValue([]),
    });

    await renderEntityTab(api);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1));

    await user.click(screen.getByLabelText('Show archived'));
    await waitFor(() =>
      expect(api.listSessions).toHaveBeenLastCalledWith({
        entityRef: 'component:default/example-payments',
        includeArchived: true,
      }),
    );
  });
});

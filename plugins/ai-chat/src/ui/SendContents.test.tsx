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


import type { ComponentType } from 'react';
import type { Entity } from '@backstage/catalog-model';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { catalogApiMock } from '@backstage/plugin-catalog-react/testUtils';
import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import { createExtensionTester } from '@backstage/frontend-test-utils';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import {
  aiChatReferenceSourcesApiRef,
  type AiChatReferenceSourceProps,
  type AiChatReferenceSourcesApi,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { AiChatReferenceSourceBlueprint } from '@kwkevinchan/backstage-plugin-ai-chat-react/alpha';
import type { ChatSessionDetail } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import aiChatPlugin from '../alpha';
import {
  createSendContentsStore,
  type SendContentsStore,
} from '../application/sendContents';
import { createAiChatReferenceSourcesApi } from '../application/referenceSourcesApi';
import { pageKey } from '../domain/references';
import {
  call,
  detail,
  insertedItem,
  items,
  mockApi,
  openStream,
  run,
  streamResponse,
  user,
} from '../testData';
import { TRUNCATED_TEXT } from './SendContents';
import { SessionView } from './SessionView';

const PAGE = { path: '/ai-chat/s-1' };

const answerStream = () =>
  streamResponse([
    { type: 'start', messageId: 'run_r-2' },
    { type: 'finish', finishReason: 'stop' },
  ]);

const entities: Entity[] = [
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'payments', namespace: 'default', title: 'Payments' },
    spec: {},
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'System',
    metadata: { name: 'billing', namespace: 'default' },
    spec: {},
  },
];

async function open(
  api: ReturnType<typeof mockApi>,
  d: ChatSessionDetail,
  options: {
    store?: SendContentsStore;
    sources?: AiChatReferenceSourcesApi;
    catalog?: boolean;
  } = {},
) {
  if (d.run?.status === 'running') {
    api.follow.mockResolvedValue(openStream().response);
  }
  const apis: Array<readonly [never, never]> = [];
  if (options.catalog) {
    apis.push([
      catalogApiRef as never,
      catalogApiMock({ entities }) as never,
    ]);
  }
  if (options.sources) {
    apis.push([aiChatReferenceSourcesApiRef as never, options.sources as never]);
  }
  await renderInTestApp(
    <TestApiProvider apis={apis}>
      <SessionView
        api={api}
        detail={d}
        toolsets={[]}
        contents={options.store}
      />
    </TestApiProvider>,
    { routeEntries: ['/ai-chat/s-1'] },
  );
}

const input = () => screen.getByLabelText('Message');

/** The tags of the box above the input. */
const box = () => screen.getByRole('list', { name: 'Sent with the message' });

function closedStore() {
  const store = createSendContentsStore();
  store.closePage(pageKey(PAGE));
  return store;
}

describe('the box of the page and the references (B-04)', () => {
  it('carries the page by default; × leaves it out as a faint "＋ Current page", which adds it back', async () => {
    const api = mockApi();
    await open(api, detail());

    const page = within(box()).getByTitle('/ai-chat/s-1');
    expect(page).toHaveTextContent('/ai-chat/s-1');
    await userEvent.click(
      screen.getByRole('button', { name: 'Leave out the current page' }),
    );

    const add = screen.getByRole('button', { name: 'Add the current page' });
    expect(add).toHaveTextContent('＋ Current page');
    expect(within(box()).queryByTitle('/ai-chat/s-1')).not.toBeInTheDocument();

    await userEvent.click(add);
    expect(within(box()).getByTitle('/ai-chat/s-1')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add the current page' }),
    ).not.toBeInTheDocument();
  });

  it('has "Current page" in "Add reference", which adds the page back', async () => {
    const api = mockApi();
    await open(api, detail(), { store: closedStore() });

    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Current page' }),
    );
    expect(within(box()).getByTitle('/ai-chat/s-1')).toBeInTheDocument();
  });

  it('sends no page in a message while the page is left out', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answerStream());
    await open(api, detail(), { store: closedStore() });

    await userEvent.type(input(), 'hello{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toStrictEqual({ text: 'hello' });
  });

  it('sends no page in an insert or a queued message while the page is left out', async () => {
    const api = mockApi();
    api.insertMessage.mockResolvedValue(insertedItem(2, 'one'));
    api.queueMessage.mockResolvedValue({
      id: 'q1',
      position: 1,
      text: 'two',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z',
    });
    await open(
      api,
      detail({ run: run('running'), items: items(user('start the work')) }),
      { store: closedStore() },
    );

    await userEvent.type(input(), 'one{Enter}');
    await waitFor(() => expect(api.insertMessage).toHaveBeenCalledTimes(1));
    expect(api.insertMessage.mock.calls[0][2]).toStrictEqual({ text: 'one' });

    await userEvent.type(input(), 'two{Control>}{Enter}{/Control}');
    await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(1));
    expect(api.queueMessage.mock.calls[0][1]).toStrictEqual({ text: 'two' });
  });

  it('sends no page in a decision while the page is left out', async () => {
    const api = mockApi();
    api.decide.mockResolvedValue(answerStream());
    await open(
      api,
      detail({
        run: run('waiting_approval'),
        awaitingDecision: ['c1'],
        items: items(user('restart payments'), call('c1')),
      }),
      { store: closedStore() },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(1));
    expect(api.decide.mock.calls[0][2]).toStrictEqual({ approved: true });
  });

  it('sends no page in a resume while the page is left out', async () => {
    const resumed = mockApi();
    resumed.resume.mockResolvedValue(answerStream());
    await open(
      resumed,
      detail({
        run: run('running'),
        resumable: true,
        items: items(user('restart payments'), call('c1')),
      }),
      { store: closedStore() },
    );
    await waitFor(() => expect(resumed.resume).toHaveBeenCalledTimes(1));
    expect(resumed.resume.mock.calls[0][1]).toStrictEqual({});
  });

  it('shows an entity by name and kind and a snippet by title and first words; a removed one is not sent, and the message shows the others', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answerStream());
    const store = createSendContentsStore();
    store.add([
      { kind: 'entity', entityRef: 'component:default/payments' },
      {
        kind: 'text',
        text: 'Restart the payments service from the console of the cluster.',
        title: 'Runbook',
        url: '/docs/runbook',
      },
      { kind: 'entity', entityRef: 'system:default/billing' },
    ]);
    await open(api, detail(), { store });

    const tags = within(box()).getAllByRole('listitem');
    expect(tags[1]).toHaveTextContent('payments');
    expect(tags[1]).toHaveTextContent('component');
    expect(tags[2]).toHaveTextContent('Runbook');
    expect(tags[2]).toHaveTextContent('Restart the payments service fro…');
    expect(tags[3]).toHaveTextContent('billing');

    await userEvent.click(screen.getByRole('button', { name: 'Remove billing' }));
    await userEvent.type(input(), 'what is this{Enter}');

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toStrictEqual({
      text: 'what is this',
      page: PAGE,
      references: [
        { kind: 'entity', entityRef: 'component:default/payments' },
        {
          kind: 'text',
          text: 'Restart the payments service from the console of the cluster.',
          title: 'Runbook',
          url: '/docs/runbook',
        },
      ],
    });
    // The box is empty again; the message shows what it carried.
    await waitFor(() =>
      expect(within(box()).getAllByRole('listitem')).toHaveLength(2),
    );
    const sent = screen.getByRole('list', { name: 'References of the message' });
    expect(sent).toHaveTextContent('payments');
    expect(sent).toHaveTextContent('Runbook');
    expect(sent).not.toHaveTextContent('billing');
  });

  it('cuts a snippet over the limit and marks it as truncated', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answerStream());
    const store = createSendContentsStore();
    store.add([{ kind: 'text', text: 'a'.repeat(4100), title: 'Long log' }]);
    await open(api, detail(), { store });

    expect(within(box()).getByText(TRUNCATED_TEXT)).toBeInTheDocument();
    await userEvent.type(input(), 'read this{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1].references).toStrictEqual([
      { kind: 'text', text: 'a'.repeat(4000), title: 'Long log' },
    ]);
  });

  it('takes no more references than GET /input-config allows, and turns the sources off then', async () => {
    const api = mockApi();
    const config = await api.getInputConfig();
    api.getInputConfig.mockResolvedValue({
      ...config,
      references: { maxPerMessage: 2, maxTextLength: 4000 },
    });
    const store = createSendContentsStore();
    await open(api, detail(), { store, catalog: true });
    await waitFor(() => expect(api.getInputConfig).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    );

    store.add([
      { kind: 'entity', entityRef: 'component:default/a' },
      { kind: 'entity', entityRef: 'component:default/b' },
      { kind: 'entity', entityRef: 'component:default/c' },
    ]);
    await waitFor(() =>
      expect(within(box()).getAllByRole('listitem')).toHaveLength(4),
    );
    expect(within(box()).queryByText('c')).not.toBeInTheDocument();
    expect(
      screen.getByText('A message carries at most 2 references.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Catalog entity' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('searches the catalog in "Add reference" and puts the chosen entity in the box', async () => {
    const api = mockApi();
    await open(api, detail(), { catalog: true });

    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Catalog entity' }),
    );
    const picker = screen.getByRole('dialog', { name: 'Catalog entity' });
    await userEvent.type(
      within(picker).getByRole('searchbox', { name: 'Search the catalog' }),
      'pay',
    );
    const list = await within(picker).findByRole('list', { name: 'Entities' });
    await waitFor(() =>
      expect(within(list).getAllByRole('button')).toHaveLength(1),
    );
    await userEvent.click(within(list).getByRole('button', { name: /Payments/ }));

    expect(
      screen.queryByRole('dialog', { name: 'Catalog entity' }),
    ).not.toBeInTheDocument();
    expect(within(box()).getByTitle('component:default/payments')).toBeInTheDocument();
  });

  it('lists a source that the app registered with createAiChatReferenceSourcesApi, and takes what it adds', async () => {
    const DocsPage: ComponentType<AiChatReferenceSourceProps> = ({
      onAdd,
      onClose,
    }) => (
      <button
        type="button"
        onClick={() => {
          onAdd([{ kind: 'text', text: 'Install with yarn.', title: 'Setup' }]);
          onClose();
        }}
      >
        Use this page
      </button>
    );
    const api = mockApi();
    await open(api, detail(), {
      sources: createAiChatReferenceSourcesApi([
        { id: 'docs-page', title: 'Documentation page', component: DocsPage },
      ]),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Documentation page' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use this page' }));

    expect(within(box()).getByText('Setup')).toBeInTheDocument();
    expect(within(box()).getByText('Install with yarn.')).toBeInTheDocument();
  });

  it('lists a source of AiChatReferenceSourceBlueprint of the new frontend system', async () => {
    const Template = () => <div>Pick a template</div>;
    const tester = createExtensionTester(
      aiChatPlugin.getExtension('api:ai-chat/reference-sources'),
    ).add(
      AiChatReferenceSourceBlueprint.make({
        name: 'template',
        params: { id: 'template', title: 'Template', component: Template },
      }),
    );
    const sources = tester
      .get(ApiBlueprint.dataRefs.factory)
      .factory({}) as AiChatReferenceSourcesApi;
    const api = mockApi();
    await open(api, detail(), { sources });

    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Template' }));
    expect(screen.getByText('Pick a template')).toBeInTheDocument();
  });

  it('shows the references of a message to the user it is shared with, without the box', async () => {
    const api = mockApi();
    await open(
      api,
      detail({
        items: items({
          ...user('what is this'),
          references: [
            {
              kind: 'entity',
              entityRef: 'component:default/payments',
              readable: true,
              entity: {
                kind: 'Component',
                namespace: 'default',
                name: 'payments',
                title: 'Payments',
              },
            },
            { kind: 'entity', entityRef: 'component:default/secret', readable: false },
            { kind: 'text', text: 'Some notes', title: 'Notes' },
          ],
        }),
        shared: { mode: 'snapshot', snapshotAt: '2026-01-01T10:00:00.000Z' },
      }),
    );

    const sent = screen.getByRole('list', { name: 'References of the message' });
    expect(sent).toHaveTextContent('Payments');
    expect(sent).toHaveTextContent('Component');
    expect(sent).toHaveTextContent('secret');
    expect(sent).toHaveTextContent('Not readable');
    expect(sent).toHaveTextContent('Notes');
    expect(
      screen.queryByRole('list', { name: 'Sent with the message' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add reference' }),
    ).not.toBeInTheDocument();
  });
});

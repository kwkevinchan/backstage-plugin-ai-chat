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

import { ReactNode } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  identityApiRef,
  type BackstageUserIdentity,
  type IdentityApi,
} from '@backstage/core-plugin-api';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import {
  AiChatLauncher,
  aiChatPanelApiRef,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { aiChatApiRef } from '../api';
import { createAiChatPanelStore } from '../application/panelStore';
import {
  answer as agentAnswer,
  detail,
  items,
  mockApi,
  session,
  streamResponse,
  user,
} from '../testData';
import { AiChatPanel } from './AiChatPanel';
import { ChatPageContent } from './ChatPage';

function Navigation() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => navigate('/catalog')}>
        Catalog
      </button>
      <button type="button" onClick={() => navigate('/settings')}>
        Settings
      </button>
      <div data-testid="where">{`${location.pathname}${location.search}`}</div>
    </>
  );
}

function answer(text: string) {
  return streamResponse([
    { type: 'start', messageId: 'run_r-1' },
    { type: 'start-step' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ]);
}

async function renderPanel(
  api: ReturnType<typeof mockApi>,
  options: {
    entry?: string;
    launcher?: ReactNode;
    identityApi?: Partial<IdentityApi>;
  } = {},
) {
  const panelApi = createAiChatPanelStore();
  const apis: Array<readonly [never, never]> = [
    [aiChatApiRef as never, api as never],
    [aiChatPanelApiRef as never, panelApi as never],
  ];
  if (options.identityApi) {
    apis.push([identityApiRef as never, options.identityApi as never]);
  }
  const view = await renderInTestApp(
    <TestApiProvider apis={apis}>
      <Navigation />
      <Routes>
        <Route path="/catalog" element={<div>Catalog page</div>} />
        <Route path="/settings" element={<div>Settings page</div>} />
      </Routes>
      <AiChatPanel />
      {options.launcher}
    </TestApiProvider>,
    { routeEntries: [options.entry ?? '/catalog'] },
  );
  return { panelApi, ...view };
}

describe('AiChatPanel', () => {
  it('keeps the open conversation mounted when the route changes', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('Hello from the model'));
    await renderPanel(api);

    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');

    expect(await screen.findByText('hi')).toBeInTheDocument();
    expect(await screen.findByText('Hello from the model')).toBeInTheDocument();
    const gets = api.getSession.mock.calls.length;
    const sends = api.sendMessage.mock.calls.length;
    expect(gets).toBeGreaterThan(0);
    expect(sends).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/settings');
    expect(screen.queryByText('Catalog page')).not.toBeInTheDocument();
    expect(screen.getByText('Settings page')).toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('Hello from the model')).toBeInTheDocument();
    expect(api.getSession).toHaveBeenCalledTimes(gets);
    expect(api.sendMessage).toHaveBeenCalledTimes(sends);
    expect(api.createSession).toHaveBeenCalledTimes(1);
  });

  it('opens a conversation from the launcher and sends the prompt with the entity', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('On the catalog page'));
    await renderPanel(api, {
      launcher: (
        <AiChatLauncher
          prompt="where is this"
          entityRef="component:default/example.com"
        >
          Ask about example.com
        </AiChatLauncher>
      ),
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Ask about example.com' }),
    );

    expect(await screen.findByText('where is this')).toBeInTheDocument();
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      {
        text: 'where is this',
        page: {
          path: '/catalog',
          entityRef: 'component:default/example.com',
        },
      },
      expect.anything(),
    );
  });

  it('sends the message without an entity that is not an entity reference', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('Still here'));
    await renderPanel(api, {
      launcher: (
        <AiChatLauncher prompt="where is this" entityRef="a b">
          Bad entity
        </AiChatLauncher>
      ),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Bad entity' }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'where is this', page: { path: '/catalog' } },
      expect.anything(),
    );
  });

  it('keeps the entity for the next message when the launcher has no prompt', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('About the component'));
    await renderPanel(api, {
      launcher: (
        <AiChatLauncher entityRef="component:default/example.com">
          Entity only
        </AiChatLauncher>
      ),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Entity only' }));
    expect(api.createSession).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      {
        text: 'hi',
        page: {
          path: '/catalog',
          entityRef: 'component:default/example.com',
        },
      },
      expect.anything(),
    );
  });

  it('keeps the composer enabled when an entity-only launch interrupts a pending prompt launch', async () => {
    let resolvePendingSession!: (value: typeof session) => void;
    const pendingCreate = new Promise<typeof session>(resolve => {
      resolvePendingSession = resolve;
    });
    const api = mockApi();
    api.createSession
      .mockReturnValueOnce(pendingCreate)
      .mockResolvedValueOnce({ ...session, id: 's-2' });
    api.getSession.mockImplementation(async id =>
      detail({ session: { ...session, id } }),
    );
    api.sendMessage.mockResolvedValue(answer('About the entity'));

    await renderPanel(api, {
      launcher: (
        <>
          <AiChatLauncher prompt="where is this">Prompt launch</AiChatLauncher>
          <AiChatLauncher entityRef="component:default/example.com">
            Entity only
          </AiChatLauncher>
        </>
      ),
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Prompt launch' }),
    );
    await userEvent.type(screen.getByLabelText('Message'), 'hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Entity only' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    await act(async () => {
      resolvePendingSession(session);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage).toHaveBeenCalledWith(
      's-2',
      {
        text: 'hello',
        page: {
          path: '/catalog',
          entityRef: 'component:default/example.com',
        },
      },
      expect.anything(),
    );
  });

  it('starts a conversation from the panel itself', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('Hello from the model'));
    await renderPanel(api);

    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      's-1',
      { text: 'hi', page: { path: '/catalog' } },
      expect.anything(),
    );
  });

  it('keeps the conversation when the panel is closed and opened again', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('Hello from the model'));
    await renderPanel(api);

    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    await userEvent.type(screen.getByLabelText('Message'), 'hi{Enter}');
    expect(await screen.findByText('Hello from the model')).toBeInTheDocument();
    const gets = api.getSession.mock.calls.length;

    await userEvent.click(
      screen.getByRole('button', { name: 'Close AI chat' }),
    );

    // The conversation stays in the document. The frame is hidden, which the
    // panel style removes from view; jsdom does not apply that stylesheet.
    const frame = document.querySelector('aside');
    expect(frame).toHaveAttribute('hidden');
    expect(frame).toHaveTextContent('hi');
    expect(frame).toHaveTextContent('Hello from the model');
    expect(
      screen.getByRole('button', { name: 'Open AI chat' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));

    expect(frame).not.toHaveAttribute('hidden');
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('Hello from the model')).toBeInTheDocument();
    expect(api.getSession).toHaveBeenCalledTimes(gets);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not let the entity on the query string replace the launched entity', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('On the catalog page'));
    await renderPanel(api, {
      entry: '/catalog?entityRef=component:default/other',
      launcher: (
        <AiChatLauncher
          prompt="where is this"
          entityRef="component:default/example.com"
        >
          Ask about example.com
        </AiChatLauncher>
      ),
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Ask about example.com' }),
    );
    expect(await screen.findByText('where is this')).toBeInTheDocument();
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][1]).toEqual({
      text: 'where is this',
      page: {
        path: '/catalog',
        entityRef: 'component:default/example.com',
      },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.type(screen.getByLabelText('Message'), 'again{Enter}');

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.sendMessage.mock.calls[1][1]).toEqual({
      text: 'again',
      page: {
        path: '/settings',
        entityRef: 'component:default/example.com',
      },
    });
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.getSession.mock.calls.length).toBeGreaterThan(0);
  });

  it('does not render until identityApi.getBackstageIdentity resolves', async () => {
    let resolveIdentity!: (identity: BackstageUserIdentity) => void;
    const identityPromise = new Promise<BackstageUserIdentity>(resolve => {
      resolveIdentity = resolve;
    });
    const api = mockApi();
    await renderPanel(api, {
      identityApi: {
        getBackstageIdentity: () => identityPromise,
      },
    });

    expect(
      screen.queryByRole('button', { name: 'Open AI chat' }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('aside')).not.toBeInTheDocument();

    await act(async () => {
      resolveIdentity({
        type: 'user',
        userEntityRef: 'user:default/guest',
        ownershipEntityRefs: ['user:default/guest'],
      });
      await Promise.resolve();
    });

    expect(
      await screen.findByRole('button', { name: 'Open AI chat' }),
    ).toBeInTheDocument();
  });

  it('stays hidden when identityApi.getBackstageIdentity rejects', async () => {
    const api = mockApi();
    await renderPanel(api, {
      identityApi: {
        getBackstageIdentity: () => Promise.reject(new Error('not signed in')),
      },
    });

    expect(
      screen.queryByRole('button', { name: 'Open AI chat' }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('aside')).not.toBeInTheDocument();
  });

  it('moves focus to the input on open, closes on Escape, restores focus and updates aria-expanded', async () => {
    const api = mockApi();
    await renderPanel(api, {
      launcher: <AiChatLauncher>Ask from page</AiChatLauncher>,
    });

    const openTab = screen.getByRole('button', { name: 'Open AI chat' });
    const launcher = screen.getByRole('button', { name: 'Ask from page' });
    expect(openTab).toHaveAttribute('aria-expanded', 'false');
    expect(launcher).toHaveAttribute('aria-expanded', 'false');

    // Open via the edge tab: focus moves into the composer textarea.
    await userEvent.click(openTab);
    expect(launcher).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Message')).toHaveFocus();

    // Pressing Escape closes the panel and restores focus to the edge tab.
    await userEvent.keyboard('{Escape}');
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    const restoredTab = screen.getByRole('button', { name: 'Open AI chat' });
    expect(restoredTab).toHaveAttribute('aria-expanded', 'false');
    expect(restoredTab).toHaveFocus();

    // Open via AiChatLauncher: closing via Escape returns focus to the launcher.
    await userEvent.click(launcher);
    expect(launcher).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Message')).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    expect(launcher).toHaveFocus();
  });

  it('keeps panel and full page on the same session working independently', async () => {
    const shared = { ...session, id: 's-shared' };
    const sharedDetail = detail({
      session: shared,
      items: items(user('hello from history'), agentAnswer('existing answer')),
    });
    const api = mockApi({
      listSessions: jest.fn().mockResolvedValue([shared]),
      getSession: jest.fn().mockResolvedValue(sharedDetail),
      createSession: jest.fn().mockResolvedValue(shared),
    });
    api.sendMessage
      .mockResolvedValueOnce(answer('panel reply'))
      .mockResolvedValueOnce(answer('page reply'));

    const panelApi = createAiChatPanelStore();
    await renderInTestApp(
      <TestApiProvider
        apis={[
          [aiChatApiRef, api],
          [aiChatPanelApiRef, panelApi],
        ]}
      >
        <Routes>
          <Route path="/ai-chat/*" element={<ChatPageContent />} />
        </Routes>
        <AiChatPanel />
      </TestApiProvider>,
      { routeEntries: ['/ai-chat/s-shared'] },
    );

    // Full page loads the shared session.
    expect(await screen.findByText('hello from history')).toBeInTheDocument();
    expect(screen.getByText('existing answer')).toBeInTheDocument();

    // Open the side panel and send a message on the same session.
    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    const aside = screen.getByRole('complementary', { name: 'AI chat' });
    await userEvent.type(
      within(aside).getByLabelText('Message'),
      'from panel{Enter}',
    );
    expect(await within(aside).findByText('panel reply')).toBeInTheDocument();

    // Send a message from the full page's own runtime as well.
    const allInputs = screen.getAllByLabelText('Message');
    const pageInput = allInputs.find(el => !aside.contains(el))!;
    expect(pageInput).toBeDefined();
    await userEvent.type(pageInput, 'from page{Enter}');
    expect(await screen.findByText('page reply')).toBeInTheDocument();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0][0]).toBe('s-shared');
    expect(api.sendMessage.mock.calls[1][0]).toBe('s-shared');
    expect(aside).not.toHaveTextContent('page reply');
    expect(within(aside).getByText('panel reply')).toBeInTheDocument();
  });

  it('ignores Escape outside the panel and during IME composition', async () => {
    const api = mockApi();
    await renderPanel(api, {
      launcher: <input aria-label="Catalog search" />,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    const aside = screen.getByRole('complementary', { name: 'AI chat' });
    const composer = within(aside).getByLabelText('Message');
    expect(composer).toHaveFocus();

    // IME composition Escape inside the panel does not close it.
    fireEvent.keyDown(composer, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(composer, { key: 'Escape', keyCode: 229 });
    expect(aside).not.toHaveAttribute('hidden');

    // Escape pressed while focus is outside the panel does not close it or steal focus.
    const externalInput = screen.getByLabelText('Catalog search');
    externalInput.focus();
    expect(externalInput).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(aside).not.toHaveAttribute('hidden');
    expect(externalInput).toHaveFocus();
  });

  it('keeps focus in the panel input when opened via AiChatLauncher with a prompt', async () => {
    const api = mockApi();
    api.sendMessage.mockResolvedValue(answer('Prompt reply'));
    await renderPanel(api, {
      launcher: <AiChatLauncher prompt="hello">Launch prompt</AiChatLauncher>,
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Launch prompt' }),
    );
    expect(await screen.findByText('Prompt reply')).toBeInTheDocument();
    const aside = screen.getByRole('complementary', { name: 'AI chat' });
    expect(within(aside).getByLabelText('Message')).toHaveFocus();
  });

  it('attaches two images in a new panel conversation using one session and sends their attachmentIds', async () => {
    const png = (name: string) =>
      new File([new Uint8Array(4)], name, { type: 'image/png' });
    const api = mockApi({
      listToolsets: jest.fn().mockResolvedValue([
        { id: 'read', title: 'Read', default: true, egress: false },
        { id: 'write', title: 'Write', default: false, egress: true },
      ]),
    });
    api.getInputConfig.mockResolvedValue({
      images: {
        enabled: true,
        mediaTypes: ['image/png'],
        maxPerMessage: 4,
        maxBytes: 1024,
        maxBytesPerInput: 20 * 1024 * 1024,
        maxPendingPerSession: 12,
      },
      insertMaxPerRun: 5,
      queueMaxMessages: 5,
      references: { maxPerMessage: 5, maxTextLength: 4000 },
    });
    api.uploadAttachment.mockImplementation(async (_s, file, name) => ({
      id: `att-${name}`,
      mediaType: file.type,
      name,
      size: file.size,
    }));
    api.sendMessage.mockResolvedValue(answer('Saw both images'));
    Object.assign(URL, {
      createObjectURL: jest.fn(() => 'blob:1'),
      revokeObjectURL: jest.fn(),
    });

    await renderPanel(api);
    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    const aside = screen.getByRole('complementary', { name: 'AI chat' });
    await within(aside).findByRole('button', { name: 'Attach' });
    await waitFor(() => expect(api.listToolsets).toHaveBeenCalled());

    const input = within(aside).getByLabelText('Message');
    fireEvent.paste(input, {
      clipboardData: {
        files: [png('a.png'), png('b.png')],
        getData: () => '',
      },
    });
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.createSession).toHaveBeenCalledWith({
      enabledToolsets: ['read'],
    });
    expect(api.uploadAttachment.mock.calls.map(c => c[0])).toEqual([
      's-1',
      's-1',
    ]);

    await userEvent.type(input, 'check images{Enter}');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        text: 'check images',
        attachmentIds: ['att-a.png', 'att-b.png'],
      }),
    );
  });

  it('deletes a pending attachment from the panel draft session when removed before sending', async () => {
    const api = mockApi();
    api.getInputConfig.mockResolvedValue({
      insertMaxPerRun: 5,
      queueMaxMessages: 5,
      references: { maxPerMessage: 5, maxTextLength: 4000 },
      images: {
        enabled: true,
        mediaTypes: ['image/png'],
        maxPerMessage: 4,
        maxBytes: 1024,
        maxBytesPerInput: 20 * 1024 * 1024,
        maxPendingPerSession: 12,
      },
    });
    api.uploadAttachment.mockImplementation(async (_s, file, name) => ({
      id: `att-${name}`,
      mediaType: file.type,
      name,
      size: file.size,
    }));
    renderPanel(api);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open AI chat' }),
    );
    const aside = await screen.findByRole('complementary', { name: 'AI chat' });
    await waitFor(() => expect(api.listToolsets).toHaveBeenCalled());

    const input = within(aside).getByLabelText('Message');
    const png = (name: string) => new File(['x'], name, { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [png('a.png')],
        getData: () => '',
      },
    });
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
    await userEvent.click(
      within(aside).getByRole('button', { name: 'Remove a.png' }),
    );
    await waitFor(() =>
      expect(api.deleteAttachment).toHaveBeenCalledWith('s-1', 'att-a.png'),
    );
  });

  it('omits Attach in the panel when the model cannot read images', async () => {
    const api = mockApi();
    api.getInputConfig.mockResolvedValue({
      images: {
        enabled: false,
        mediaTypes: ['image/png'],
        maxPerMessage: 4,
        maxBytes: 1024,
        maxBytesPerInput: 20 * 1024 * 1024,
        maxPendingPerSession: 12,
      },
      insertMaxPerRun: 5,
      queueMaxMessages: 5,
      references: { maxPerMessage: 5, maxTextLength: 4000 },
    });
    await renderPanel(api);
    await userEvent.click(screen.getByRole('button', { name: 'Open AI chat' }));
    await waitFor(() => expect(api.getInputConfig).toHaveBeenCalled());
    const aside = screen.getByRole('complementary', { name: 'AI chat' });
    expect(within(aside).queryByRole('button', { name: 'Attach' })).toBeNull();
  });
});

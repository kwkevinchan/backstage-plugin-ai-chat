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

import { act, fireEvent, render, screen } from '@testing-library/react';
import { launchContextOf } from '../domain/launch';
import { resetDefaultAiChatPanelStore } from './panelStore';
import {
  AiChatPanelProvider,
  useAiChatPanel,
  useAiChatPanelStore,
} from './useAiChatPanel';
import { createAiChatPanelStore } from './panelStore';

function Reader() {
  const panel = useAiChatPanel();
  return (
    <div data-testid="state">
      {JSON.stringify({
        isOpen: panel.isOpen,
        sessionId: panel.sessionId ?? null,
        launch: panel.launch ?? null,
        launchId: panel.launchId,
      })}
    </div>
  );
}

function Controls() {
  const panel = useAiChatPanel();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          panel.open({
            prompt: '  where  ',
            entityRef: 'component:default/example.com',
          })
        }
      >
        launch
      </button>
      <button type="button" onClick={() => panel.setSession('s-1')}>
        session
      </button>
      <button type="button" onClick={() => panel.close()}>
        close
      </button>
      <button type="button" onClick={() => panel.open()}>
        reveal
      </button>
      <Reader />
    </>
  );
}

const state = () =>
  JSON.parse(screen.getByTestId('state').textContent ?? '{}') as {
    isOpen: boolean;
    sessionId: string | null;
    launch: { prompt?: string; entityRef?: string } | null;
    launchId: number;
  };

describe('useAiChatPanel', () => {
  afterEach(() => {
    act(() => {
      resetDefaultAiChatPanelStore();
    });
  });

  it('a launch through the hook is the launch context, and close keeps the session', () => {
    const store = createAiChatPanelStore();
    render(
      <AiChatPanelProvider store={store}>
        <Controls />
      </AiChatPanelProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'launch' }));
    expect(state()).toMatchObject({
      isOpen: true,
      sessionId: null,
      launch: launchContextOf({
        prompt: '  where  ',
        entityRef: 'component:default/example.com',
      }),
    });
    // The prompt cleared the session, so remember one after the launch.
    fireEvent.click(screen.getByRole('button', { name: 'session' }));
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(state()).toMatchObject({
      isOpen: false,
      sessionId: 's-1',
      launch: { prompt: 'where', entityRef: 'component:default/example.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'reveal' }));
    expect(state()).toMatchObject({
      isOpen: true,
      sessionId: 's-1',
      launchId: 1,
    });
  });

  it('shares the default store when there is no provider', () => {
    function Opener() {
      const panel = useAiChatPanel();
      return (
        <button type="button" onClick={() => panel.open({ prompt: 'where' })}>
          open
        </button>
      );
    }
    render(
      <>
        <Opener />
        <Reader />
      </>,
    );
    expect(state().isOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(state()).toMatchObject({
      isOpen: true,
      launch: { prompt: 'where' },
    });

    function Mark() {
      const store = useAiChatPanelStore();
      return (
        <div data-testid="shared">{store.getSnapshot().launch?.prompt}</div>
      );
    }
    render(<Mark />);
    expect(screen.getByTestId('shared')).toHaveTextContent('where');
  });
});

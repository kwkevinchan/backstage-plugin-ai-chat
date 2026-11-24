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

import { fireEvent, render, screen } from '@testing-library/react';
import { createAiChatPanelStore } from '../application/panelStore';
import {
  AiChatPanelProvider,
  useAiChatPanel,
} from '../application/useAiChatPanel';
import { AiChatLauncher } from './AiChatLauncher';

function State() {
  const panel = useAiChatPanel();
  return (
    <div data-testid="state">
      {JSON.stringify({
        isOpen: panel.isOpen,
        launch: panel.launch ?? null,
      })}
    </div>
  );
}

function renderLauncher(props: {
  prompt?: string;
  entityRef?: string;
  children?: string;
}) {
  const store = createAiChatPanelStore();
  render(
    <AiChatPanelProvider store={store}>
      <AiChatLauncher {...props} />
      <State />
    </AiChatPanelProvider>,
  );
  return store;
}

describe('AiChatLauncher', () => {
  it('opens the panel with the prompt and the entity', () => {
    renderLauncher({
      prompt: ' where is this ',
      entityRef: 'component:default/example.com',
      children: 'Ask about example.com',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Ask about example.com' }),
    );
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '')).toEqual({
      isOpen: true,
      launch: {
        prompt: 'where is this',
        entityRef: 'component:default/example.com',
      },
    });
  });

  it('opens the panel without a prompt or an entity', () => {
    const store = renderLauncher({});
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI chat' }));
    expect(store.getSnapshot()).toEqual({ open: true, launchId: 0 });
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '')).toEqual({
      isOpen: true,
      launch: null,
    });
  });
});

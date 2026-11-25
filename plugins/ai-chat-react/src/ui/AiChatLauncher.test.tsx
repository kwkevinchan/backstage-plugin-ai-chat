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

import { TestApiProvider } from '@backstage/test-utils';
import { fireEvent, render, screen } from '@testing-library/react';
import { aiChatPanelApiRef, type AiChatPanelApi } from '../api';
import { AiChatLauncher } from './AiChatLauncher';

function mockPanelApi(): jest.Mocked<AiChatPanelApi> {
  return {
    isOpen: jest.fn(() => false),
    open: jest.fn(),
    close: jest.fn(),
    subscribe: jest.fn((_listener: () => void) => () => {}),
  };
}

describe('AiChatLauncher', () => {
  it('opens the panel with the prompt and the entity', () => {
    const api = mockPanelApi();
    render(
      <TestApiProvider apis={[[aiChatPanelApiRef, api]]}>
        <AiChatLauncher
          prompt="where is this"
          entityRef="component:default/example.com"
          className="custom-launcher"
        >
          Ask about example.com
        </AiChatLauncher>
      </TestApiProvider>,
    );

    const button = screen.getByRole('button', {
      name: 'Ask about example.com',
    });
    expect(button).toHaveClass('custom-launcher');
    fireEvent.click(button);
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.open).toHaveBeenCalledWith({
      prompt: 'where is this',
      entityRef: 'component:default/example.com',
    });
  });

  it('opens the panel without a prompt or an entity', () => {
    const api = mockPanelApi();
    render(
      <TestApiProvider apis={[[aiChatPanelApiRef, api]]}>
        <AiChatLauncher />
      </TestApiProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI chat' }));
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.open).toHaveBeenCalledWith();
  });

  it('renders nothing when aiChatPanelApiRef is not registered', () => {
    const { container } = render(
      <TestApiProvider apis={[]}>
        <AiChatLauncher prompt="where is this">
          Ask about example.com
        </AiChatLauncher>
      </TestApiProvider>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

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
import {
  aiChatPanelApiRef,
  type AiChatLaunchRequest,
  type AiChatPanelApi,
} from '../api';
import { useAiChatPanel } from './useAiChatPanel';

function createFakePanelApi(): AiChatPanelApi & {
  requests: Array<AiChatLaunchRequest | undefined>;
} {
  let open = false;
  const listeners = new Set<() => void>();
  const requests: Array<AiChatLaunchRequest | undefined> = [];
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    requests,
    isOpen: () => open,
    open(request) {
      requests.push(request);
      if (!open) {
        open = true;
        notify();
      }
    },
    close() {
      if (open) {
        open = false;
        notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function Controls() {
  const panel = useAiChatPanel();
  return (
    <>
      <div data-testid="open">{String(panel.isOpen)}</div>
      <button
        type="button"
        onClick={() =>
          panel.open({
            prompt: 'where',
            entityRef: 'component:default/example.com',
          })
        }
      >
        launch
      </button>
      <button type="button" onClick={() => panel.open()}>
        reveal
      </button>
      <button type="button" onClick={() => panel.close()}>
        close
      </button>
    </>
  );
}

describe('useAiChatPanel', () => {
  it('reads and updates open state through aiChatPanelApiRef', () => {
    const api = createFakePanelApi();
    render(
      <TestApiProvider apis={[[aiChatPanelApiRef, api]]}>
        <Controls />
      </TestApiProvider>,
    );

    expect(screen.getByTestId('open')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'launch' }));
    expect(screen.getByTestId('open')).toHaveTextContent('true');
    expect(api.requests).toEqual([
      { prompt: 'where', entityRef: 'component:default/example.com' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.getByTestId('open')).toHaveTextContent('false');

    fireEvent.click(screen.getByRole('button', { name: 'reveal' }));
    expect(screen.getByTestId('open')).toHaveTextContent('true');
    expect(api.requests).toEqual([
      { prompt: 'where', entityRef: 'component:default/example.com' },
      undefined,
    ]);
  });

  it('returns closed state and no-op actions when aiChatPanelApiRef is absent', () => {
    render(
      <TestApiProvider apis={[]}>
        <Controls />
      </TestApiProvider>,
    );

    expect(screen.getByTestId('open')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'launch' }));
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.getByTestId('open')).toHaveTextContent('false');
  });
});

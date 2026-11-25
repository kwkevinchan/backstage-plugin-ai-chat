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

import { createAiChatPanelStore, getAiChatPanelStore } from './panelStore';

describe('createAiChatPanelStore', () => {
  it('open, close, and setSession notify and keep the snapshot stable', () => {
    const api = createAiChatPanelStore();
    const store = getAiChatPanelStore(api);
    const first = store.getSnapshot();
    const seen: unknown[] = [];
    api.subscribe(() => seen.push(store.getSnapshot()));

    api.open();
    api.open();
    expect(seen).toHaveLength(1);
    expect(api.isOpen()).toBe(true);
    expect(store.getSnapshot()).toEqual({ open: true, launchId: 0 });
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    store.setSession('s-1');
    store.setSession('s-1');
    expect(seen).toHaveLength(2);
    expect(store.getSnapshot().sessionId).toBe('s-1');

    const open = store.getSnapshot();
    api.close();
    api.close();
    expect(seen).toHaveLength(3);
    expect(api.isOpen()).toBe(false);
    expect(store.getSnapshot()).toEqual({
      open: false,
      launchId: 0,
      sessionId: 's-1',
    });
    expect(store.getSnapshot()).not.toBe(open);
  });

  it('treats open with prompt or entityRef as a launch and trims/validates', () => {
    const api = createAiChatPanelStore();
    const store = getAiChatPanelStore(api);
    api.open({
      prompt: '  where  ',
      entityRef: 'component:default/example.com',
    });
    expect(store.getSnapshot()).toEqual({
      open: true,
      launchId: 1,
      launch: {
        prompt: 'where',
        entityRef: 'component:default/example.com',
      },
    });

    store.setSession('s-1');
    api.open();
    expect(store.getSnapshot()).toEqual({
      open: true,
      launchId: 1,
      sessionId: 's-1',
      launch: {
        prompt: 'where',
        entityRef: 'component:default/example.com',
      },
    });
  });

  it('runs one task per launch and shares it with a second caller', async () => {
    const store = getAiChatPanelStore(createAiChatPanelStore());
    let runs = 0;
    const task = () => {
      runs += 1;
      return Promise.resolve('ok');
    };
    const first = store.start(1, task);
    const second = store.start(1, task);
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(runs).toBe(1);
    expect(first).toBe(second);
  });

  it('forgets a launch whose task failed', async () => {
    const store = getAiChatPanelStore(createAiChatPanelStore());
    let runs = 0;
    const task = () => {
      runs += 1;
      return Promise.reject(new Error('nope'));
    };
    await expect(store.start(1, task)).rejects.toThrow('nope');
    await expect(store.start(1, task)).rejects.toThrow('nope');
    expect(runs).toBe(2);
  });
});

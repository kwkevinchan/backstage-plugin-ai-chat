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

import {
  applyClose,
  applyLaunch,
  applyOpen,
  applySession,
  initialPanelState,
  type PanelState,
} from './panel';

const openWithSession = (): PanelState => ({
  open: true,
  sessionId: 's-1',
  launch: { entityRef: 'component:default/example.com' },
  launchId: 3,
});

describe('panel state', () => {
  it('opens a new conversation when the launch has a prompt', () => {
    const next = applyLaunch(openWithSession(), { prompt: '  where  ' });
    expect(next).toEqual({
      open: true,
      launch: { prompt: 'where' },
      launchId: 4,
    });
    expect(next.sessionId).toBeUndefined();
    const again = applyLaunch(next, { prompt: 'where' });
    expect(again.launchId).toBe(5);
    expect(again.sessionId).toBeUndefined();
  });

  it('opens a new conversation for the draft of a launch with references', () => {
    const next = applyLaunch(openWithSession(), {
      prompt: 'where',
      references: [{ kind: 'text', text: 'a note' }],
    });
    expect(next).toEqual({
      open: true,
      launch: { draft: 'where' },
      launchId: 4,
    });
  });

  it('keeps the conversation when the launch has no prompt', () => {
    const next = applyLaunch(openWithSession(), {
      prompt: '   ',
      entityRef: 'component:default/example.com',
    });
    expect(next.sessionId).toBe('s-1');
    expect(next.open).toBe(true);
    expect(next.launch).toEqual({
      entityRef: 'component:default/example.com',
    });
    expect(next.launchId).toBe(4);
  });

  it('close leaves the conversation and the context in place', () => {
    const state = openWithSession();
    const closed = applyClose(state);
    expect(closed).toEqual({ ...state, open: false });
    expect(applyClose(closed)).toBe(closed);
    expect(applySession(closed, 's-1')).toBe(closed);
  });

  it('opening without a launch does not clear the conversation', () => {
    const closed: PanelState = { ...openWithSession(), open: false };
    const opened = applyOpen(closed);
    expect(opened).toEqual({ ...closed, open: true });
    expect(applyOpen(opened)).toBe(opened);
    expect(initialPanelState()).toEqual({ open: false, launchId: 0 });
  });

  it('does not store the route', () => {
    const launched = applyLaunch(initialPanelState(), {
      prompt: 'where',
      entityRef: 'component:default/example.com',
    });
    expect(Object.keys(launched).sort()).toEqual([
      'launch',
      'launchId',
      'open',
    ]);
    expect(launched).not.toHaveProperty('path');
    const remembered = applySession(launched, 's-1');
    expect(Object.keys(remembered).sort()).toEqual([
      'launch',
      'launchId',
      'open',
      'sessionId',
    ]);
  });
});

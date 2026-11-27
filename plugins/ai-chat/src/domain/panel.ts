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

import type { AiChatLaunchRequest } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { launchContextOf, type LaunchContext } from './launch';

/**
 * The side panel. The route is not stored: changing it does not close the
 * panel and does not drop the conversation.
 */
export interface PanelState {
  /** Whether the panel is open. */
  open: boolean;
  /** The conversation on the panel. Absent until the first message. */
  sessionId?: string;
  /** What the last launch carried. Absent until something is launched. */
  launch?: LaunchContext;
  /**
   * Increases on every launch, including a second launch with the same
   * prompt, so that launch starts a new conversation.
   */
  launchId: number;
}

/** A closed panel with no conversation. */
export function initialPanelState(): PanelState {
  return { open: false, launchId: 0 };
}

/**
 * Opens the panel and leaves the conversation and the launch as they are.
 * The same state when the panel is already open.
 */
export function applyOpen(state: PanelState): PanelState {
  return state.open ? state : { ...state, open: true };
}

/**
 * Opens the panel for a launch. A prompt, sent or waiting as a draft,
 * replaces the conversation. Without one, the conversation stays. The launch replaces the previous one.
 */
export function applyLaunch(
  state: PanelState,
  request: AiChatLaunchRequest,
): PanelState {
  const launch = launchContextOf(request);
  const sessionId = launch.prompt || launch.draft ? undefined : state.sessionId;
  return {
    open: true,
    launch,
    launchId: state.launchId + 1,
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * Closes the panel. The conversation and the launch stay, so opening it
 * again shows the same conversation. The same state when it is already closed.
 */
export function applyClose(state: PanelState): PanelState {
  if (!state.open) return state;
  return { ...state, open: false };
}

/**
 * Remembers the conversation the panel started, or forgets it when the id
 * is absent. The same state when the id did not change.
 */
export function applySession(
  state: PanelState,
  sessionId: string | undefined,
): PanelState {
  if (state.sessionId === sessionId) return state;
  if (sessionId === undefined) {
    const { sessionId: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, sessionId };
}

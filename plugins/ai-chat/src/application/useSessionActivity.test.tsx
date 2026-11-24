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

import { act, renderHook } from '@testing-library/react';
import type { ChatSession } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { session } from '../testData';
import {
  ACTIVITY_POLL_MS,
  useSessionActivity,
  type ActivityMessage,
} from './useSessionActivity';

const listed = (activity?: ChatSession['activity']): ChatSession => ({
  ...session,
  ...(activity && { activity }),
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSessionActivity', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls the list once a second when there is no signals subscription', async () => {
    jest.useFakeTimers();
    const lists: ChatSession[][] = [[listed('running')], [listed()]];
    let n = 0;
    const listSessions = jest.fn(
      async () => lists[Math.min(n++, lists.length - 1)],
    );
    const { result, rerender } = renderHook(
      ({ open }: { open?: string }) =>
        useSessionActivity({ listSessions, openSessionId: open }),
      { initialProps: { open: undefined as string | undefined } },
    );

    await flush();
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[0].activity).toBe('running');
    expect(result.current.sessions[0].newReply).toBeUndefined();

    await act(async () => {
      jest.advanceTimersByTime(ACTIVITY_POLL_MS);
    });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(ACTIVITY_POLL_MS).toBe(1000);
    expect(result.current.sessions[0].activity).toBeUndefined();
    expect(result.current.sessions[0].newReply).toBe(true);

    rerender({ open: session.id });
    expect(result.current.sessions[0].newReply).toBeUndefined();
  });

  it('refreshes when a signal arrives and does not poll', async () => {
    jest.useFakeTimers();
    let onMessage: (message: ActivityMessage) => void = () => {};
    const stop = jest.fn();
    const subscribe = jest.fn((cb: (message: ActivityMessage) => void) => {
      onMessage = cb;
      return stop;
    });
    const listSessions = jest
      .fn()
      .mockResolvedValueOnce([listed('waiting_approval')])
      .mockResolvedValueOnce([listed('running')]);
    const { result, unmount } = renderHook(() =>
      useSessionActivity({ listSessions, subscribe }),
    );

    await flush();
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(result.current.sessions[0].activity).toBe('waiting_approval');

    await act(async () => {
      jest.advanceTimersByTime(ACTIVITY_POLL_MS * 5);
    });
    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      onMessage({ sessionId: session.id, activity: 'running' });
    });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(result.current.sessions[0].activity).toBe('running');

    unmount();
    expect(stop).toHaveBeenCalled();
  });
});

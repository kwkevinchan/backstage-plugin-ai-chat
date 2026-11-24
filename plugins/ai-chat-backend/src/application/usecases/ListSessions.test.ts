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

import type { Session } from '../../domain';
import { ListSessions } from './ListSessions';

const jane = { userRef: 'user:default/jane' } as any;

const session = (id: string): Session => ({
  id,
  ownerRef: 'user:default/jane',
  agentId: 'default',
  enabledToolsets: [],
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const active = (
  sessionId: string,
  status: 'running' | 'waiting_approval' | 'completed',
) => ({ id: `run-${sessionId}`, sessionId, status });

describe('ListSessions', () => {
  it('adds the activity of the active run', async () => {
    const sessions = [session('s-run'), session('s-wait'), session('s-idle')];
    const findActiveForSessions = jest.fn(async (ids: readonly string[]) => {
      expect(ids).toEqual(['s-run', 's-wait', 's-idle']);
      return [
        active('s-run', 'running'),
        active('s-wait', 'waiting_approval'),
        active('s-idle', 'completed'),
      ];
    });
    const useCase = new ListSessions({
      sessions: {
        listByOwner: async () => sessions,
      } as any,
      runs: { findActiveForSessions } as any,
    });

    const listed = await useCase.execute({ principal: jane });

    expect(listed.map(item => [item.id, item.activity])).toEqual([
      ['s-run', 'running'],
      ['s-wait', 'waiting_approval'],
      ['s-idle', undefined],
    ]);
  });
});

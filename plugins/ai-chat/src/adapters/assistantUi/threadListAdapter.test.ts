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

import { detail, mockApi, session } from '../../testData';
import {
  createThreadListAdapter,
  readThreadCustom,
  toRemoteThreadMetadata,
} from './threadListAdapter';

async function readChunks(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return chunks;
}

describe('threadListAdapter', () => {
  it('lists sessions with query and includeArchived and maps custom pinned/activity', async () => {
    const api = mockApi({
      listSessions: jest.fn().mockResolvedValue([
        {
          ...session,
          id: 's-1',
          title: 'Pinned chat',
          pinned: true,
          activity: 'running',
        },
        {
          ...session,
          id: 's-2',
          title: 'Archived chat',
          archivedAt: '2026-11-26T00:00:00.000Z',
          pinned: false,
          activity: 'waiting_approval',
        },
      ]),
    });
    const adapter = createThreadListAdapter({
      api,
      query: '  chat  ',
      includeArchived: true,
      entityRef: 'component:default/example-payments',
    });

    const result = await adapter.list();

    expect(api.listSessions).toHaveBeenCalledWith({
      query: 'chat',
      includeArchived: true,
      entityRef: 'component:default/example-payments',
    });
    expect(result.threads).toEqual([
      {
        status: 'regular',
        remoteId: 's-1',
        title: 'Pinned chat',
        lastMessageAt: new Date(session.updatedAt),
        custom: { pinned: true, activity: 'running' },
      },
      {
        status: 'archived',
        remoteId: 's-2',
        title: 'Archived chat',
        lastMessageAt: new Date(session.updatedAt),
        custom: { pinned: false, activity: 'waiting_approval' },
      },
    ]);
  });

  it('fetches a single session via GET /sessions/:id', async () => {
    const api = mockApi({
      getSession: jest.fn().mockResolvedValue(
        detail({
          session: {
            ...session,
            id: 's-9',
            title: 'Fetched',
            pinned: true,
          },
        }),
      ),
    });
    const adapter = createThreadListAdapter({ api });

    const meta = await adapter.fetch('s-9');

    expect(api.getSession).toHaveBeenCalledWith('s-9');
    expect(meta).toEqual(
      toRemoteThreadMetadata({
        ...session,
        id: 's-9',
        title: 'Fetched',
        pinned: true,
      }),
    );
  });

  it('initializes a session via POST /sessions', async () => {
    const api = mockApi({
      createSession: jest.fn().mockResolvedValue({ ...session, id: 's-new' }),
    });
    const adapter = createThreadListAdapter({ api });

    const created = await adapter.initialize('local-1', {
      custom: { enabledToolsets: ['read'] },
    });

    expect(api.createSession).toHaveBeenCalledWith({
      enabledToolsets: ['read'],
    });
    expect(created).toEqual({ remoteId: 's-new' });
  });

  it('renames, archives, deletes and updates pinned via the session API and omits unarchive', async () => {
    const api = mockApi();
    const onActionStart = jest.fn();
    const onActionSuccess = jest.fn();
    const onCustomUpdated = jest.fn();
    const onDeleted = jest.fn();
    const adapter = createThreadListAdapter({
      api,
      onActionStart,
      onActionSuccess,
      onCustomUpdated,
      onDeleted,
    });

    expect(adapter.unarchive).toBeUndefined();

    await adapter.rename('s-1', 'New title');
    expect(api.updateSession).toHaveBeenCalledWith('s-1', {
      title: 'New title',
    });

    await adapter.archive('s-1');
    expect(api.updateSession).toHaveBeenCalledWith('s-1', { archived: true });

    await adapter.updateCustom!('s-1', { pinned: true });
    expect(api.updateSession).toHaveBeenCalledWith('s-1', { pinned: true });
    expect(onCustomUpdated).toHaveBeenCalledTimes(1);

    await adapter.delete('s-1');
    expect(api.deleteSession).toHaveBeenCalledWith('s-1');
    expect(onDeleted).toHaveBeenCalledWith('s-1');

    expect(onActionStart).toHaveBeenCalledTimes(4);
    expect(onActionSuccess).toHaveBeenCalledTimes(4);
  });

  it('reports mutation errors and rethrows so optimistic updates roll back', async () => {
    const boom = new Error('Conflict');
    const api = mockApi({
      deleteSession: jest.fn().mockRejectedValue(boom),
    });
    const onActionError = jest.fn();
    const adapter = createThreadListAdapter({ api, onActionError });

    await expect(adapter.delete('s-1')).rejects.toThrow('Conflict');
    expect(onActionError).toHaveBeenCalledWith(boom);
  });

  it('generateTitle polls until the backend title appears without calling a model', async () => {
    const api = mockApi({
      getSession: jest
        .fn()
        .mockResolvedValueOnce(
          detail({ session: { ...session, title: undefined } }),
        )
        .mockResolvedValueOnce(
          detail({ session: { ...session, title: 'Backend title' } }),
        ),
    });
    const adapter = createThreadListAdapter({
      api,
      generateTitlePollMs: 5,
      generateTitleTimeoutMs: 500,
    });

    const stream = await adapter.generateTitle('s-1', []);
    const chunks = await readChunks(stream as unknown as ReadableStream);

    expect(api.getSession).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(chunks).toEqual([
      { type: 'part-start', path: [0], part: { type: 'text' } },
      { type: 'text-delta', path: [0], textDelta: 'Backend title' },
      { type: 'part-finish', path: [0] },
    ]);
  });

  it('generateTitle closes cleanly when the timeout elapses without a title', async () => {
    const api = mockApi({
      getSession: jest
        .fn()
        .mockResolvedValue(
          detail({ session: { ...session, title: undefined } }),
        ),
    });
    const adapter = createThreadListAdapter({
      api,
      generateTitlePollMs: 5,
      generateTitleTimeoutMs: 15,
    });

    const stream = await adapter.generateTitle('s-1', []);
    const chunks = await readChunks(stream as unknown as ReadableStream);

    expect(chunks).toEqual([]);
  });

  it('readThreadCustom extracts pinned and valid activity values', () => {
    expect(readThreadCustom(undefined)).toEqual({ pinned: false });
    expect(readThreadCustom({ pinned: true, activity: 'running' })).toEqual({
      pinned: true,
      activity: 'running',
    });
    expect(readThreadCustom({ pinned: false, activity: 'unexpected' })).toEqual(
      { pinned: false },
    );
  });
});

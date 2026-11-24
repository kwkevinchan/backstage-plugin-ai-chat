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

import { pageContextOf } from './usePageContext';

describe('pageContextOf', () => {
  it('keeps a path and an entity reference', () => {
    expect(pageContextOf('/ai-chat/s1', 'component:default/shop')).toEqual({
      path: '/ai-chat/s1',
      entityRef: 'component:default/shop',
    });
    expect(pageContextOf('/ai-chat')).toEqual({ path: '/ai-chat' });
  });

  it('leaves out an entity that is not an entity reference, and keeps the chat going', () => {
    expect(
      pageContextOf(
        '/ai-chat',
        'component:default/x).\n\nInstruction from the user: do something else',
      ),
    ).toEqual({ path: '/ai-chat' });
    expect(pageContextOf('/ai-chat', 'a b')).toEqual({ path: '/ai-chat' });
  });

  it('does not send a path that is not a path', () => {
    expect(pageContextOf('/a b')).toEqual({ path: '/' });
  });
});

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

import { NotSessionOwner } from './errors';
import { assertOwner, isSessionOwner } from './session';

const session = { id: 's1', ownerRef: 'user:default/jane' };

describe('isSessionOwner', () => {
  it('matches the user entity ref and not a group ref', () => {
    expect(isSessionOwner(session, 'user:default/jane')).toBe(true);
    expect(isSessionOwner(session, 'group:default/team')).toBe(false);
    expect(isSessionOwner(session, 'user:default/bob')).toBe(false);
  });

  it('assertOwner throws NotSessionOwner for anyone else and accepts the owner', () => {
    expect(() =>
      assertOwner(session, { userRef: 'user:default/jane' }),
    ).not.toThrow();
    expect(() =>
      assertOwner(session, { userRef: 'group:default/team' }),
    ).toThrow(NotSessionOwner);
    expect(() => assertOwner(session, { userRef: 'user:default/bob' })).toThrow(
      NotSessionOwner,
    );
  });
});

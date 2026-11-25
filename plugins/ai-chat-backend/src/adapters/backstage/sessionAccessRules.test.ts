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

import type { SessionAccess } from './sessionAccess';
import { isSessionOwnerRule, isSharedWithRule } from './sessionAccess';

const ownedByJane: SessionAccess = {
  ownerRef: 'user:default/jane',
  shares: [],
};

describe('IS_SESSION_OWNER', () => {
  it('matches only a user ref equal to ownerRef', () => {
    expect(
      isSessionOwnerRule.apply(ownedByJane, {
        userRefs: ['user:default/jane'],
      }),
    ).toBe(true);
    expect(
      isSessionOwnerRule.apply(ownedByJane, {
        userRefs: ['user:default/bob', 'user:default/jane'],
      }),
    ).toBe(true);
    expect(
      isSessionOwnerRule.apply(ownedByJane, { userRefs: ['user:default/bob'] }),
    ).toBe(false);
    expect(isSessionOwnerRule.apply(ownedByJane, { userRefs: [] })).toBe(false);
  });

  it('a group ref is not the owner', () => {
    expect(
      isSessionOwnerRule.apply(ownedByJane, {
        userRefs: ['group:default/team'],
      }),
    ).toBe(false);
  });

  it('toQuery of an empty ref list matches nothing', () => {
    expect(isSessionOwnerRule.toQuery({ userRefs: [] })).toEqual({
      ownerRef: '',
    });
    expect(
      isSessionOwnerRule.toQuery({
        userRefs: ['user:default/jane', 'user:default/bob'],
      }),
    ).toEqual({
      anyOf: [
        { ownerRef: 'user:default/jane' },
        { ownerRef: 'user:default/bob' },
      ],
    });
  });
});

describe('IS_SHARED_WITH', () => {
  const resource: SessionAccess = {
    ownerRef: 'user:default/jane',
    shares: [
      { subjectRef: 'group:default/team' },
      { subjectRef: 'user:default/bob', revokedAt: '2026-03-01T00:00:00.000Z' },
      { subjectRef: 'user:default/cara' },
    ],
  };

  it('matches a user or a group subject and not a revoked share', () => {
    expect(
      isSharedWithRule.apply(resource, { subjectRefs: ['group:default/team'] }),
    ).toBe(true);
    expect(
      isSharedWithRule.apply(resource, { subjectRefs: ['user:default/cara'] }),
    ).toBe(true);
    expect(
      isSharedWithRule.apply(resource, { subjectRefs: ['user:default/bob'] }),
    ).toBe(false);
  });

  it('does not match someone who is not in the group', () => {
    expect(
      isSharedWithRule.apply(resource, {
        subjectRefs: ['user:default/dave', 'group:default/other'],
      }),
    ).toBe(false);
  });

  it('does not match someone who left the group, and a direct share still matches', () => {
    const left = {
      ...resource,
      shares: [{ subjectRef: 'group:default/team' }],
    };
    expect(
      isSharedWithRule.apply(left, { subjectRefs: ['user:default/bob'] }),
    ).toBe(false);
    const direct = {
      ...resource,
      shares: [{ subjectRef: 'user:default/bob' }],
    };
    expect(
      isSharedWithRule.apply(direct, { subjectRefs: ['user:default/bob'] }),
    ).toBe(true);
  });

  it('still matches an expired share', () => {
    // Expiry is not part of the resource: a share that is not revoked still
    // grants the read, and the items freeze on their own.
    expect(
      isSharedWithRule.apply(
        {
          ownerRef: 'user:default/jane',
          shares: [{ subjectRef: 'group:default/team' }],
        },
        { subjectRefs: ['group:default/team'] },
      ),
    ).toBe(true);
  });

  it('toQuery of an empty ref list matches nothing', () => {
    expect(isSharedWithRule.toQuery({ subjectRefs: [] })).toEqual({
      subjectRef: '',
      revoked: false,
    });
    expect(
      isSharedWithRule.toQuery({ subjectRefs: ['group:default/team'] }),
    ).toEqual({ subjectRef: 'group:default/team', revoked: false });
  });
});

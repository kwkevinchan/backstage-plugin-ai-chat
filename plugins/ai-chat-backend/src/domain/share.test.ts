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
  allowsSessionRead,
  shareGrantsRead,
  shareScope,
  type Share,
} from './share';

const jane = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane', 'group:default/team'],
};
const bobInGroup = {
  userRef: 'user:default/bob',
  ownershipRefs: ['user:default/bob', 'group:default/team'],
};
const bobAlone = {
  userRef: 'user:default/bob',
  ownershipRefs: ['user:default/bob'],
};
const cara = {
  userRef: 'user:default/cara',
  ownershipRefs: ['user:default/cara', 'group:default/other'],
};

function share(partial: Partial<Share> & Pick<Share, 'subjectRef'>): Share {
  return {
    id: 'sh1',
    sessionId: 's1',
    createdBy: 'user:default/jane',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('shareScope', () => {
  it('stores the seq at share time as the output bound of a live share when none is given', () => {
    expect(shareScope({ mode: 'live', atSeq: 7 })).toEqual({
      outputsUpToSeq: 7,
    });
  });

  it('treats an explicit null output bound on a live share as every output in range', () => {
    expect(
      shareScope({ mode: 'live', atSeq: 7, outputsUpToSeq: null }),
    ).toEqual({});
  });

  it('keeps an explicit output bound on a live share, including 0', () => {
    expect(shareScope({ mode: 'live', atSeq: 7, outputsUpToSeq: 3 })).toEqual({
      outputsUpToSeq: 3,
    });
    expect(shareScope({ mode: 'live', atSeq: 7, outputsUpToSeq: 0 })).toEqual({
      outputsUpToSeq: 0,
    });
  });

  it('stores the seq at share time on a snapshot and no output bound when none is given', () => {
    expect(shareScope({ mode: 'snapshot', atSeq: 7 })).toEqual({ upToSeq: 7 });
  });

  it('keeps an explicit output bound on a snapshot and treats null as every output in range', () => {
    expect(
      shareScope({ mode: 'snapshot', atSeq: 7, outputsUpToSeq: 2 }),
    ).toEqual({ upToSeq: 7, outputsUpToSeq: 2 });
    expect(
      shareScope({ mode: 'snapshot', atSeq: 7, outputsUpToSeq: null }),
    ).toEqual({ upToSeq: 7 });
    expect(
      shareScope({ mode: 'snapshot', atSeq: 7, outputsUpToSeq: 0 }),
    ).toEqual({ upToSeq: 7, outputsUpToSeq: 0 });
  });
});

describe('shareGrantsRead', () => {
  it('grants read for the user or a group, and not when the share is revoked', () => {
    expect(
      shareGrantsRead(share({ subjectRef: 'user:default/bob' }), bobInGroup),
    ).toBe(true);
    expect(
      shareGrantsRead(share({ subjectRef: 'group:default/team' }), bobInGroup),
    ).toBe(true);
    expect(
      shareGrantsRead(
        share({
          subjectRef: 'group:default/team',
          revokedAt: '2026-02-01T00:00:00.000Z',
        }),
        bobInGroup,
      ),
    ).toBe(false);
    expect(
      shareGrantsRead(
        share({
          subjectRef: 'user:default/bob',
          revokedAt: '2026-02-01T00:00:00.000Z',
        }),
        bobInGroup,
      ),
    ).toBe(false);
  });

  it('does not grant read to someone who is not in the group', () => {
    expect(
      shareGrantsRead(share({ subjectRef: 'group:default/team' }), cara),
    ).toBe(false);
  });

  it('does not grant read of a group share to someone who left the group', () => {
    expect(
      shareGrantsRead(share({ subjectRef: 'group:default/team' }), bobAlone),
    ).toBe(false);
  });

  it('still grants a direct share after the person left the group', () => {
    expect(
      shareGrantsRead(share({ subjectRef: 'user:default/bob' }), bobAlone),
    ).toBe(true);
  });

  it('still grants read when the share is expired', () => {
    expect(
      shareGrantsRead(
        share({
          subjectRef: 'group:default/team',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        bobInGroup,
      ),
    ).toBe(true);
  });
});

describe('allowsSessionRead', () => {
  const session = { ownerRef: 'user:default/jane' };

  it('allows the owner with no share, and refuses a stranger', () => {
    expect(allowsSessionRead(session, jane, [])).toBe(true);
    expect(allowsSessionRead(session, cara, [])).toBe(false);
    expect(
      allowsSessionRead(session, bobInGroup, [
        share({
          subjectRef: 'group:default/team',
          revokedAt: '2026-02-01T00:00:00.000Z',
        }),
      ]),
    ).toBe(false);
    expect(
      allowsSessionRead(session, bobInGroup, [
        share({ subjectRef: 'group:default/team' }),
      ]),
    ).toBe(true);
  });
});

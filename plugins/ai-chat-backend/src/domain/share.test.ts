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
  createShareScope,
  isShareExpired,
  liveShareExpiry,
  normalizeSubjectRef,
  shareGrantsRead,
  shareModeOf,
  shareScope,
  updatedShareScope,
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

describe('normalizeSubjectRef', () => {
  it.each([
    ['user:default/bob', 'user:default/bob'],
    ['group:default/team', 'group:default/team'],
    ['user:bob', 'user:default/bob'],
    ['User:Default/Bob', 'user:default/Bob'],
    ['  group:ops/SRE  ', 'group:ops/SRE'],
  ])('reads %p as %p', (ref, normalized) => {
    expect(normalizeSubjectRef(ref)).toBe(normalized);
  });

  it.each([
    'component:default/x',
    'bob',
    'user:',
    'user:default/',
    'user:a/b/c',
    'user:default/b ob',
    'user:x:y/z',
  ])('refuses %p', ref => {
    expect(normalizeSubjectRef(ref)).toBeUndefined();
  });
});

describe('shareModeOf and isShareExpired', () => {
  it('is live without a seq cap and a snapshot with one', () => {
    expect(shareModeOf({})).toBe('live');
    expect(shareModeOf({ upToSeq: 0 })).toBe('snapshot');
  });

  it('expires only after expiresAt, not at the same instant', () => {
    const at = '2026-01-02T00:00:00.000Z';
    expect(isShareExpired({ expiresAt: at }, at)).toBe(false);
    expect(isShareExpired({ expiresAt: at }, '2026-01-02T00:00:00.001Z')).toBe(
      true,
    );
    expect(isShareExpired({}, '2099-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('createShareScope', () => {
  it.each([
    [{ mode: 'snapshot' as const }, { upToSeq: 7 }],
    [
      { mode: 'snapshot' as const, includeToolOutputs: false },
      { upToSeq: 7, outputsUpToSeq: 0 },
    ],
    [{ mode: 'live' as const }, { outputsUpToSeq: 7 }],
    [{ mode: 'live' as const, includeLaterToolOutputs: true }, {}],
    [
      { mode: 'live' as const, includeToolOutputs: false },
      { outputsUpToSeq: 0 },
    ],
  ])('maps %p at seq 7 to %p', (request, scope) => {
    expect(createShareScope(request, 7)).toEqual(scope);
  });

  it('refuses later output on a snapshot, and later output without output', () => {
    expect(() =>
      createShareScope({ mode: 'snapshot', includeLaterToolOutputs: true }, 7),
    ).toThrow(expect.objectContaining({ name: 'InvalidShare' }));
    expect(() =>
      createShareScope(
        {
          mode: 'live',
          includeToolOutputs: false,
          includeLaterToolOutputs: true,
        },
        7,
      ),
    ).toThrow(expect.objectContaining({ name: 'InvalidShare' }));
  });
});

describe('updatedShareScope', () => {
  const snapshot = { upToSeq: 3 };
  const hidden = { upToSeq: 3, outputsUpToSeq: 0 };
  const live = { outputsUpToSeq: 3 };

  it.each([
    [
      'refresh moves a snapshot to now',
      snapshot,
      { refresh: true },
      { upToSeq: 9 },
    ],
    [
      'refresh keeps hidden output hidden',
      hidden,
      { refresh: true },
      { upToSeq: 9, outputsUpToSeq: 0 },
    ],
    [
      'hides the output of a snapshot',
      snapshot,
      { includeToolOutputs: false },
      hidden,
    ],
    [
      'shows every output of a snapshot again',
      hidden,
      { includeToolOutputs: true },
      snapshot,
    ],
    [
      'shows the later output of a live share',
      live,
      { includeLaterToolOutputs: true },
      {},
    ],
    [
      'stops the output of a live share at now',
      {},
      { includeLaterToolOutputs: false },
      { outputsUpToSeq: 9 },
    ],
    [
      'shows the output of a live share up to now',
      { outputsUpToSeq: 0 },
      { includeToolOutputs: true },
      { outputsUpToSeq: 9 },
    ],
    [
      'hides the output of a live share',
      live,
      { includeToolOutputs: false },
      { outputsUpToSeq: 0 },
    ],
    ['changes nothing for an empty change', live, {}, live],
  ])('%s', (_name, share, change, scope) => {
    expect(updatedShareScope(share, change, 9)).toEqual(scope);
  });

  it('refuses a refresh of a live share and later output on a snapshot', () => {
    expect(() => updatedShareScope(live, { refresh: true }, 9)).toThrow(
      expect.objectContaining({ name: 'InvalidShare' }),
    );
    expect(() =>
      updatedShareScope(snapshot, { includeLaterToolOutputs: false }, 9),
    ).toThrow(expect.objectContaining({ name: 'InvalidShare' }));
    expect(() =>
      updatedShareScope(
        live,
        { includeToolOutputs: false, includeLaterToolOutputs: true },
        9,
      ),
    ).toThrow(expect.objectContaining({ name: 'InvalidShare' }));
  });
});

describe('liveShareExpiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const limits = { defaultHours: 24, maxHours: 72 };

  it('is defaultHours from now when no life is given, or the hours given', () => {
    expect(liveShareExpiry(now, undefined, limits)).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(liveShareExpiry(now, 72, limits)).toBe('2026-01-04T00:00:00.000Z');
    expect(liveShareExpiry(now, 1, limits)).toBe('2026-01-01T01:00:00.000Z');
  });

  it.each([0, -1, 73, 1.5])('refuses %p hours', hours => {
    expect(() => liveShareExpiry(now, hours, limits)).toThrow(
      expect.objectContaining({ name: 'InvalidShare' }),
    );
  });
});

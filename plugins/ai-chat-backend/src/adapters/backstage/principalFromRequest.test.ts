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

import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import type { Request } from 'express';
import { principalFromRequest } from './principalFromRequest';

const request = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} } as unknown as Request);

describe('principalFromRequest', () => {
  const services = {
    httpAuth: mockServices.httpAuth(),
    userInfo: mockServices.userInfo(),
    auth: mockServices.auth(),
  };

  it('reads the user, the groups they own through, and when the token ends', async () => {
    const principal = await principalFromRequest(
      request(mockCredentials.user.header('user:default/jane')),
      services,
    );
    expect(principal).toMatchObject({
      userRef: 'user:default/jane',
      ownershipRefs: expect.arrayContaining(['user:default/jane']),
    });
    expect(principal.credentials).toBeDefined();
    expect(Date.parse(principal.credentialsExpireAt!)).toBeGreaterThan(
      Date.now(),
    );
  });

  it('leaves the expiry out when the token cannot tell it', async () => {
    const principal = await principalFromRequest(
      request(mockCredentials.user.header('user:default/jane')),
      {
        ...services,
        auth: mockServices.auth.mock({
          getLimitedUserToken: jest.fn().mockRejectedValue(new Error('no')),
        }),
      },
    );
    expect(principal.userRef).toBe('user:default/jane');
    expect('credentialsExpireAt' in principal).toBe(false);
  });

  it('refuses a service', async () => {
    await expect(
      principalFromRequest(request(mockCredentials.service.header()), services),
    ).rejects.toThrow();
  });
});

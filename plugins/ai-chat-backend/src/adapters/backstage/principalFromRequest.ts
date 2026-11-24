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

import type {
  AuthService,
  HttpAuthService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import type { Request } from 'express';
import type { Principal } from '../../domain';

/**
 * Reads the signed-in user from a request: only a user is accepted, never a
 * service. `credentials` is what the tools run with; `credentialsExpireAt` is
 * when the token of the user stops working, so a run can end before that (V-06).
 * The expiry is left out when the token cannot tell it.
 */
export async function principalFromRequest(
  req: Request,
  services: {
    httpAuth: HttpAuthService;
    userInfo: UserInfoService;
    auth: AuthService;
  },
): Promise<Principal> {
  const credentials = await services.httpAuth.credentials(req, {
    allow: ['user'],
  });
  const info = await services.userInfo.getUserInfo(credentials);
  let credentialsExpireAt: string | undefined;
  try {
    const { expiresAt } = await services.auth.getLimitedUserToken(credentials);
    credentialsExpireAt = expiresAt.toISOString();
  } catch {
    // A token that cannot say when it expires: the configured limit applies.
  }
  return {
    userRef: info.userEntityRef,
    ownershipRefs: info.ownershipEntityRefs,
    credentials,
    ...(credentialsExpireAt !== undefined && { credentialsExpireAt }),
  };
}

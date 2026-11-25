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

import type { Principal, Share, Session } from '../../domain';

/**
 * Whether a principal may read a session (SH-05). `false` is the same as the
 * session not existing: the caller gets `NotSessionOwner`.
 */
export interface AccessControl {
  canReadSession(input: {
    session: Pick<Session, 'id' | 'ownerRef'>;
    principal: Principal;
    shares: readonly Share[];
  }): Promise<boolean>;
}

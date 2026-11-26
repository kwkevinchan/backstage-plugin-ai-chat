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
  type Principal,
  type Share,
  type Session,
} from '../domain';
import type { AccessControl } from './ports';

/**
 * The owner, or someone a share names, reads a session; everyone uses every
 * toolset. The permission framework is not asked.
 * Tests and the integration host use this; the plugin uses
 * `PermissionAccessControl`, which falls back to the same rule.
 */
export class OwnerOrShareAccessControl implements AccessControl {
  canReadSession(input: {
    session: Pick<Session, 'id' | 'ownerRef'>;
    principal: Principal;
    shares: readonly Share[];
  }): Promise<boolean> {
    return Promise.resolve(
      allowsSessionRead(input.session, input.principal, input.shares),
    );
  }

  usableToolsets(input: {
    principal: Principal;
    toolsetIds: readonly string[];
  }): Promise<string[]> {
    return Promise.resolve([...input.toolsetIds]);
  }
}

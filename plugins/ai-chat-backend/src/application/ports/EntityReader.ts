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

import type { EntityFacts, Principal } from '../../domain';

/** Reads entities of the catalog as a user. */
export interface EntityReader {
  /**
   * The entity with this ref (`kind:namespace/name`), read with the
   * credentials of `principal`. `undefined` when it does not exist or the
   * user cannot read it; the catalog does not tell these apart. Throws when
   * the catalog cannot be reached.
   */
  read(
    entityRef: string,
    principal: Principal,
  ): Promise<EntityFacts | undefined>;
}

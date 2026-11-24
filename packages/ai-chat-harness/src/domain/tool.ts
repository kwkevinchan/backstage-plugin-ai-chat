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

import type { JsonObject } from './item';

/**
 * A tool as the loop sees it. The host builds it from an action of the
 * actions registry and the settings of the toolset.
 *
 * @public
 */
export type ToolDescriptor = {
  id: string;
  /** A short name for the screen. */
  title?: string;
  description: string;
  /** JSON Schema of the input. */
  inputSchema: JsonObject;
  /** A hash of the schema, stored with each call (T-06). */
  schemaHash: string;
  /**
   * Whether the tool only reads. Anything but `true` counts as not read-only
   * (D-06).
   */
  readOnly: boolean;
  /**
   * Whether the tool sends data out of the organization; set by the
   * administrator on the toolset (T-04).
   */
  egress?: boolean;
};

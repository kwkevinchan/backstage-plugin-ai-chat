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

/**
 * Who makes a request. The host reads the user from the request (see
 * `principalFromRequest`); the inner circles only pass the value along.
 */
export type Principal = {
  /** The entity ref of the user, for example `user:default/jane`. */
  userRef: string;
  /** The entity refs the user owns through, the user and their groups. */
  ownershipRefs: string[];
  /**
   * What the tools run with. Only the adapter of the tools knows its type; it
   * is the credentials of the request that starts or continues a run.
   */
  credentials: unknown;
  /**
   * ISO 8601; when the credentials stop working, if known. A run does not work
   * beyond it (see `runLimits`).
   */
  credentialsExpireAt?: string;
};

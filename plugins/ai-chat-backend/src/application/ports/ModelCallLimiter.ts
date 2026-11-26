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
 * Hands out model calls of one model, a number per minute, over all backends
 * that share it (P-06).
 */
export interface ModelCallLimiter {
  /**
   * Takes one call of `modelId` in the minute of `now`, when fewer than
   * `perMinute` were taken in it. Otherwise nothing is taken, and `retryAt`
   * is the start of the next minute. The store decides between callers at
   * the same time, also on other backends.
   */
  tryAcquire(
    modelId: string,
    perMinute: number,
    now: Date,
  ): Promise<{ acquired: true } | { acquired: false; retryAt: Date }>;
}

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

import { ResponseError } from '@backstage/errors';

/** The status code of a failed request of the chat backend, if the error is one. */
export function statusOf(error: unknown): number | undefined {
  return error instanceof ResponseError ? error.response.status : undefined;
}

/**
 * The name of the error that the backend answered with (`InsertLimitReached`,
 * `QueueChanged`...), which tells apart the errors that share a status code.
 */
export function errorNameOf(error: unknown): string | undefined {
  return error instanceof ResponseError ? error.body?.error?.name : undefined;
}

/**
 * The text to show for an error. The message of a failed request is the
 * status line; the reason that the backend gave is in its cause.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

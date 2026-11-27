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
 * Safe structured fields to log for an unexpected error: its name, optional
 * short error code, and optional HTTP status. Never includes `error.message`
 * or the raw error object, since messages from model servers, tools, or
 * downstream services can echo user or tool content.
 */
export function errorLogFields(error: unknown): {
  errorName: string;
  errorCode?: string;
  errorStatus?: number;
} {
  const errorCode = errorCodeOf(error);
  const errorStatus = errorStatusOf(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(errorCode !== undefined && { errorCode }),
    ...(errorStatus !== undefined && { errorStatus }),
  };
}

/** Alias of {@link errorLogFields} for model-call failure logs. */
export const modelErrorFields = errorLogFields;

/** Short non-whitespace error code (e.g. `ECONNREFUSED`, `23505`), if present. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' &&
    code.length > 0 &&
    code.length <= 64 &&
    !/\s/.test(code)
    ? code
    : undefined;
}

/** The HTTP status an error carries in `status`, if it has one. */
export function errorStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

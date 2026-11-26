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
 * What the log may say of an error of a model call: its name and its HTTP
 * status. Not its message: the message of a model server can carry back what
 * the user or a tool wrote.
 */
export function modelErrorFields(error: unknown): {
  errorName: string;
  errorStatus?: number;
} {
  const errorStatus = errorStatusOf(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(errorStatus !== undefined && { errorStatus }),
  };
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

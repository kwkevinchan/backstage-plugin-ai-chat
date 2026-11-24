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
 * Tells whether a database error is a unique-constraint violation on a
 * column, the same way for PostgreSQL (error code 23505, the column in the
 * detail or the name of the constraint) and SQLite (the column in the
 * message, for example `UNIQUE constraint failed: runs.active_session_id`).
 */
export function isUniqueViolation(error: unknown, column: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message, detail, constraint } = error as {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
    constraint?: unknown;
  };
  const text = [message, detail, constraint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  if (code === '23505') return text.includes(column);
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return text.includes('UNIQUE') && text.includes(column);
  }
  return false;
}

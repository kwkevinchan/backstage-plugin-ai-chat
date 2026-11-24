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
  ConflictError,
  InputError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
import {
  AgentNotFound,
  NotSessionOwner,
  RunAlreadyActive,
  RunNotFound,
  RunNotWaiting,
  SessionNotFound,
  ShuttingDown,
  ToolCallNotFound,
  ToolCallNotWaiting,
  UnknownToolset,
} from '../../domain';
import { toHttpError } from './errorMapping';

describe('toHttpError', () => {
  it.each([
    [new SessionNotFound('s1'), NotFoundError],
    [new RunNotFound('r1'), NotFoundError],
    [new ToolCallNotFound('c1'), NotFoundError],
    [new NotSessionOwner('s1'), NotFoundError],
    [new RunAlreadyActive('s1'), ConflictError],
    [new RunNotWaiting('r1'), ConflictError],
    [new ToolCallNotWaiting('c1'), ConflictError],
    [new UnknownToolset('t1'), InputError],
    [new AgentNotFound('a1'), InputError],
    [new ShuttingDown(), ServiceUnavailableError],
  ])('maps %p to %p', (error, expected) => {
    expect(toHttpError(error)).toBeInstanceOf(expected);
  });

  it('answers a session of another user like a session that does not exist', () => {
    const notOwner = toHttpError(new NotSessionOwner('s1')) as Error;
    const missing = toHttpError(new SessionNotFound('s1')) as Error;
    expect(notOwner.message).toBe(missing.message);
    expect(notOwner.message).not.toContain('owner');
  });

  it('leaves any other error as it is', () => {
    const error = new Error('insert into "items" failed');
    expect(toHttpError(error)).toBe(error);
  });
});

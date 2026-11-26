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
import { InvalidRunTransition, LeaseLost } from '@kwkevinchan/ai-chat-harness';
import {
  AgentNotFound,
  EmptyMessage,
  InsertLimitReached,
  InvalidShare,
  LiveSharingDisabled,
  NoActiveRun,
  NotSessionOwner,
  QueueChanged,
  QueuedMessageNotFound,
  QueueFull,
  RunAlreadyActive,
  RunNotFound,
  RunNotRunning,
  RunNotWaiting,
  SessionNotFound,
  ShareNotFound,
  ShuttingDown,
  ToolCallNotFound,
  ToolCallNotWaiting,
  TooManyActiveRuns,
  UnknownToolset,
} from '../../domain';
import { toHttpError } from './errorMapping';

const noop = () => {};

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
    [new LeaseLost('r1'), ConflictError],
    [new InvalidRunTransition('completed', 'running'), ConflictError],
  ])('maps %p to %p', (error, expected) => {
    expect(toHttpError(error, noop)).toBeInstanceOf(expected);
  });

  it.each([
    [new RunNotRunning('r1'), 'RunNotRunning', 409],
    [new InsertLimitReached('r1', 5), 'InsertLimitReached', 409],
    [new NoActiveRun('s1'), 'NoActiveRun', 409],
    [new QueueFull('s1', 5), 'QueueFull', 409],
    [new QueueChanged('s1'), 'QueueChanged', 409],
    [new QueuedMessageNotFound('q1'), 'QueuedMessageNotFound', 404],
    [new EmptyMessage(), 'EmptyMessage', 400],
    [new TooManyActiveRuns(3), 'TooManyActiveRuns', 429],
    [new ShareNotFound('sh1'), 'ShareNotFound', 404],
    [new InvalidShare('hours must be an integer'), 'InvalidShare', 400],
    [new LiveSharingDisabled(), 'LiveSharingDisabled', 400],
  ])(
    'keeps the name of %p in the answer, with the status %p',
    (error, name, status) => {
      const answer = toHttpError(error, noop) as Error & { statusCode: number };
      // The error handler of Backstage answers with `statusCode` and `name`.
      expect(answer.name).toBe(name);
      expect(answer.statusCode).toBe(status);
      expect(answer.message).toBe(error.message);
    },
  );

  it('answers a session of another user like a session that does not exist', () => {
    const notOwner = toHttpError(new NotSessionOwner('s1'), noop) as Error;
    const missing = toHttpError(new SessionNotFound('s1'), noop) as Error;
    expect(notOwner.message).toBe(missing.message);
    expect(notOwner.message).not.toContain('owner');
  });

  it('keeps an error of Backstage as it is', () => {
    const error = new InputError('bad body');
    expect(toHttpError(error, noop)).toBe(error);
  });

  it('answers an unexpected error with a fixed text, and hands the error to the log', () => {
    const seen: unknown[] = [];
    const error = new Error('insert into "items" failed');
    const answer = toHttpError(error, e => seen.push(e));
    expect(answer).not.toBe(error);
    expect(answer.message).toBe('The request failed.');
    expect(answer.message).not.toContain('insert');
    expect(seen).toEqual([error]);
  });

  it('does not log the errors it maps', () => {
    const seen: unknown[] = [];
    toHttpError(new SessionNotFound('s1'), e => seen.push(e));
    expect(seen).toEqual([]);
  });
});

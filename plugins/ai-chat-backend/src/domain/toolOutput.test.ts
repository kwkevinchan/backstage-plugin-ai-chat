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
  MAX_REDACT_DEPTH,
  OutputTooDeep,
  REDACTED,
  redactFields,
  toolOutputLimits,
} from './toolOutput';

describe('toolOutputLimits (T-09)', () => {
  it('is the limit of the installation and nothing to hide without a rule', () => {
    expect(toolOutputLimits('catalog:get', [], 20000)).toEqual({
      maxChars: 20000,
      redact: [],
    });
  });

  it('takes the smallest limit and every field of the rules that match', () => {
    const rules = [
      { pattern: '*', redact: ['password'] },
      { pattern: 'catalog:*', maxOutputChars: 8000, redact: ['token'] },
      { pattern: 'catalog:get', maxOutputChars: 4000, redact: ['password'] },
      { pattern: 'other:*', maxOutputChars: 100, redact: ['other'] },
    ];
    expect(toolOutputLimits('catalog:get', rules, 20000)).toEqual({
      maxChars: 4000,
      redact: ['password', 'token'],
    });
    expect(toolOutputLimits('catalog:list', rules, 20000)).toEqual({
      maxChars: 8000,
      redact: ['password', 'token'],
    });
    expect(toolOutputLimits('web:fetch', rules, 20000)).toEqual({
      maxChars: 20000,
      redact: ['password'],
    });
  });
});

describe('redactFields (T-09)', () => {
  it('hides a field at any depth, in objects and in arrays of objects', () => {
    expect(
      redactFields(
        {
          a: { token: 'S', keep: 1 },
          list: [{ token: 'S' }, { nested: { token: { deep: 'S' } } }],
          token: null,
        },
        ['token'],
      ),
    ).toEqual({
      a: { token: REDACTED, keep: 1 },
      list: [{ token: REDACTED }, { nested: { token: REDACTED } }],
      token: REDACTED,
    });
  });

  it('matches the field name exactly, with its case', () => {
    expect(redactFields({ Token: 'a', tokens: 'b' }, ['token'])).toEqual({
      Token: 'a',
      tokens: 'b',
    });
  });

  it('does not change the value it gets', () => {
    const value = { token: 'S' };
    redactFields(value, ['token']);
    expect(value).toEqual({ token: 'S' });
  });

  it('keeps a __proto__ key as a key', () => {
    const value = JSON.parse('{"__proto__": {"token": "S"}}');
    const redacted = redactFields(value, ['token']) as Record<string, unknown>;
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(redacted, '__proto__')?.value,
    ).toEqual({ token: REDACTED });
  });

  it('returns the value as it is with nothing to hide', () => {
    const value = { token: 'S' };
    expect(redactFields(value, [])).toBe(value);
    expect(redactFields('text', ['token'])).toBe('text');
  });

  it(`throws past ${MAX_REDACT_DEPTH} levels instead of leaving them unchecked`, () => {
    const nest = (levels: number): unknown =>
      levels === 0 ? { token: 'S' } : { next: nest(levels - 1) };
    expect(() =>
      redactFields(nest(MAX_REDACT_DEPTH - 1) as any, ['token']),
    ).not.toThrow();
    expect(() =>
      redactFields(nest(MAX_REDACT_DEPTH) as any, ['token']),
    ).toThrow(OutputTooDeep);
  });
});

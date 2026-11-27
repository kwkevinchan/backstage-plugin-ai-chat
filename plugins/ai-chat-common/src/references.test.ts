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

import { isReferenceUrl, MAX_REFERENCE_URL_LENGTH } from './references';

describe('isReferenceUrl', () => {
  it('takes http, https and paths, and refuses other links', () => {
    for (const value of [
      'https://example.com/docs/page#part',
      'http://example.com',
      'HTTPS://example.com/a?b=c',
      '/docs/default/component/shop',
      '/',
    ]) {
      expect([value, isReferenceUrl(value)]).toEqual([value, true]);
    }
    for (const value of [
      '',
      'javascript:alert(1)',
      'data:text/html,hi',
      'mailto:someone@example.com',
      'ftp://example.com/file',
      'example.com/docs',
      'docs/page',
      '//example.com/x',
      '/\\example.com/x',
      'https://example.com/a b',
      'https://example.com/\n',
      '/docs\u0000',
      'https://',
      `https://example.com/${'a'.repeat(MAX_REFERENCE_URL_LENGTH)}`,
    ]) {
      expect([value, isReferenceUrl(value)]).toEqual([value, false]);
    }
  });
});

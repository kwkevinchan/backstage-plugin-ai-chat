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
 * Most references (entities and text snippets) one message may carry (B-04).
 * The administrator may set a lower number; images do not count.
 *
 * @public
 */
export const MAX_REFERENCES_PER_MESSAGE = 5;

/** Most characters of the text of one text snippet. @public */
export const MAX_REFERENCE_TEXT_LENGTH = 4000;

/** Most characters of the title of a text snippet. @public */
export const MAX_REFERENCE_TITLE_LENGTH = 200;

/** Most characters of the link of a text snippet. @public */
export const MAX_REFERENCE_URL_LENGTH = 2000;

/**
 * Whether a text is a link a text snippet may name as its source: an
 * absolute `http:` or `https:` URL, or a path of this site that starts with
 * one `/`. No blank and no control character. A path that starts with `//`
 * or `/\` is refused: a browser reads it as the address of another site.
 *
 * @public
 */
export function isReferenceUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REFERENCE_URL_LENGTH) {
    return false;
  }
  if (!/^[^\s\p{C}]+$/u.test(value)) return false;
  if (value.startsWith('/')) return !/^\/[/\\]/.test(value);
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

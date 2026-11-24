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

import type { JsonValue } from '@backstage/types';
import type { ChatCutOutput } from '../common';

export interface LimitedOutput {
  /** What is stored and shown: the output, or its first part when it was cut. */
  stored: JsonValue | ChatCutOutput;
  /** What the model reads. */
  text: string;
  truncated: boolean;
}

/**
 * Keeps the output of an action within `maxChars` characters of JSON text. A
 * longer output is cut, and both the stored value and the text for the model
 * say so.
 */
export function limitOutput(
  output: JsonValue,
  maxChars: number,
): LimitedOutput {
  const json = JSON.stringify(output) ?? 'null';
  if (json.length <= maxChars) {
    return { stored: output, text: json, truncated: false };
  }
  const text = json.slice(0, maxChars);
  return {
    stored: { truncated: true, originalLength: json.length, text },
    text: `${text}\n[The output was cut: ${maxChars} of ${json.length} characters are shown.]`,
    truncated: true,
  };
}

/** Cuts a message that is shown to the user or the model; never the input of a call. */
export function cutText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

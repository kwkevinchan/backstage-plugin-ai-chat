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

import type { JsonValue } from '@kwkevinchan/ai-chat-harness';
import { matchesActionPattern } from './toolset';

/**
 * What the administrator sets for the output of the actions that match
 * `pattern` (T-09): a lower limit of characters, and the fields to hide.
 */
export type ToolOutputRule = {
  /** Action ID pattern; `*` matches any characters, `:` included. */
  pattern: string;
  /** Most characters of the output that are kept. */
  maxOutputChars?: number;
  /** Field names whose values are hidden, at any depth. */
  redact: readonly string[];
};

/** The limit and the fields to hide for the output of one action. */
export type ToolOutputLimits = {
  maxChars: number;
  redact: readonly string[];
};

/** What a hidden value becomes. */
export const REDACTED = '[redacted]';

/** The deepest output that is checked for fields to hide. */
export const MAX_REDACT_DEPTH = 100;

/**
 * The limits of one action: the smallest limit of the rules that match it
 * (and `maxChars`, the limit of the installation), and every field they hide.
 * Rules only make the limits stricter, so their order does not matter.
 */
export function toolOutputLimits(
  actionId: string,
  rules: readonly ToolOutputRule[],
  maxChars: number,
): ToolOutputLimits {
  let limit = maxChars;
  const redact = new Set<string>();
  for (const rule of rules) {
    if (!matchesActionPattern(rule.pattern, actionId)) continue;
    if (rule.maxOutputChars !== undefined) {
      limit = Math.min(limit, rule.maxOutputChars);
    }
    for (const field of rule.redact) redact.add(field);
  }
  return { maxChars: limit, redact: [...redact] };
}

/** The output is nested deeper than {@link MAX_REDACT_DEPTH}. */
export class OutputTooDeep extends Error {
  constructor() {
    super(`The output is nested deeper than ${MAX_REDACT_DEPTH} levels`);
    this.name = 'OutputTooDeep';
  }
}

/**
 * `value` with the value of every field named in `fields` replaced by
 * {@link REDACTED}, in objects at any depth, also in arrays. The key stays.
 * Throws `OutputTooDeep` past {@link MAX_REDACT_DEPTH} levels, so nothing
 * deeper is left unchecked.
 */
export function redactFields(
  value: JsonValue,
  fields: readonly string[],
): JsonValue {
  if (fields.length === 0) return value;
  const hidden = new Set(fields);
  const walk = (node: JsonValue, depth: number): JsonValue => {
    if (typeof node !== 'object' || node === null) return node;
    if (depth > MAX_REDACT_DEPTH) throw new OutputTooDeep();
    if (Array.isArray(node)) return node.map(child => walk(child, depth + 1));
    // `fromEntries` defines own properties, so a `__proto__` key stays a key.
    return Object.fromEntries(
      Object.entries(node)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [
          key,
          hidden.has(key) ? REDACTED : walk(child as JsonValue, depth + 1),
        ]),
    );
  };
  return walk(value, 1);
}

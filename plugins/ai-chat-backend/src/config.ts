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

import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';

export interface AiChatConfig {
  llm: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
  };
  maxTurns: number;
  systemPrompt?: string;
  actions: {
    include: string[];
    exclude: string[];
  };
  maxToolOutputChars: number;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20000;
/** A cut output keeps a wrapper of about 30 characters, so a smaller limit keeps no text. */
const MIN_MAX_TOOL_OUTPUT_CHARS = 100;

function positiveInt(
  config: Config,
  key: string,
  fallback: number,
  min = 1,
): number {
  const value = config.getOptionalNumber(key) ?? fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new InputError(
      min === 1
        ? `${key} must be a positive integer, got ${value}`
        : `${key} must be an integer of at least ${min}, got ${value}`,
    );
  }
  return value;
}

/** Reads and checks the `aiChat` section of the configuration. */
export function readAiChatConfig(root: Config): AiChatConfig {
  const config = root.getConfig('aiChat');
  const baseUrl = config.getString('llm.baseUrl').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new InputError(
      'aiChat.llm.baseUrl must start with http:// or https://',
    );
  }
  const apiKey = config.getOptionalString('llm.apiKey');
  return {
    llm: {
      baseUrl,
      apiKey,
      model: config.getString('llm.model'),
      timeoutMs:
        positiveInt(config, 'llm.timeoutSeconds', DEFAULT_TIMEOUT_SECONDS) *
        1000,
    },
    maxTurns: positiveInt(config, 'maxTurns', DEFAULT_MAX_TURNS),
    systemPrompt: config.getOptionalString('systemPrompt'),
    actions: {
      include: config.getOptionalStringArray('actions.include') ?? [],
      exclude: config.getOptionalStringArray('actions.exclude') ?? [],
    },
    maxToolOutputChars: positiveInt(
      config,
      'maxToolOutputChars',
      DEFAULT_MAX_TOOL_OUTPUT_CHARS,
      MIN_MAX_TOOL_OUTPUT_CHARS,
    ),
  };
}

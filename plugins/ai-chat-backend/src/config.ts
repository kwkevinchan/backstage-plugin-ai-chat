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
  /** Most tool calls the model requests in one run. */
  maxToolCallsPerRun: number;
  /** Seconds of working time of one run, without the wait for approvals. */
  runTimeoutSeconds: number;
  systemPrompt?: string;
  actions: {
    include: string[];
    exclude: string[];
  };
  maxToolOutputChars: number;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 30;
const DEFAULT_RUN_TIMEOUT_SECONDS = 300;
/**
 * The shortest life that `auth.backstageTokenExpiration` allows for the token
 * of a user. A run works with the token of the request that started it or
 * continued it after an approval, so it stays within this (V-06).
 */
const MAX_RUN_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20000;
/** A cut output keeps a wrapper of about 30 characters, so a smaller limit keeps no text. */
const MIN_MAX_TOOL_OUTPUT_CHARS = 100;

function positiveInt(
  config: Config,
  key: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = config.getOptionalNumber(key) ?? fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new InputError(
      min === 1
        ? `${key} must be a positive integer, got ${value}`
        : `${key} must be an integer of at least ${min}, got ${value}`,
    );
  }
  if (value > max) {
    throw new InputError(`${key} must be at most ${max}, got ${value}`);
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
    maxToolCallsPerRun: positiveInt(
      config,
      'maxToolCallsPerRun',
      DEFAULT_MAX_TOOL_CALLS_PER_RUN,
    ),
    runTimeoutSeconds: positiveInt(
      config,
      'runTimeoutSeconds',
      DEFAULT_RUN_TIMEOUT_SECONDS,
      1,
      MAX_RUN_TIMEOUT_SECONDS,
    ),
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

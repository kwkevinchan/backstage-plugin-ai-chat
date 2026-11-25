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
import {
  DEFAULT_IMAGE_LIMITS,
  DEFAULT_INSERT_MAX_PER_RUN,
  DEFAULT_QUEUE_MAX_MESSAGES,
  DEFAULT_RETENTION_DAYS,
  type ImageLimits,
} from './domain';

export interface AiChatConfig {
  llm: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    /** The model reads images (IN-05). */
    images: boolean;
  };
  maxTurns: number;
  /** Most tool calls the model requests in one run. */
  maxToolCallsPerRun: number;
  /** Seconds of working time of one run, without the wait for approvals. */
  runTimeoutSeconds: number;
  /** How much the model gets of a long session (H-09). */
  context: { tokenBudget: number; keepRecentSteps: number };
  /** What the user may add while a run goes on (IN-10, IN-13). */
  input: {
    /** Most messages inserted into one run. */
    insertMaxPerRun: number;
    /** Most messages in the queue of one session. */
    queueMaxMessages: number;
    /** The limits on the images of a message (IN-01, IN-04, IN-06). */
    images: ImageLimits;
  };
  systemPrompt?: string;
  actions: {
    include: string[];
    exclude: string[];
  };
  maxToolOutputChars: number;
  /**
   * Limits for a share that keeps updating. Always filled in: a missing block
   * uses the defaults.
   */
  sharing: {
    live: {
      /** Whether a share may keep updating. */
      enabled: boolean;
      /** Hours a live share lasts when nobody picks a life. */
      defaultHours: number;
      /** Longest life of a live share, in hours. */
      maxHours: number;
    };
  };
  /**
   * Days a session is kept after its last change (SE-05). 0 deletes nothing.
   */
  retentionDays: number;
}

/**
 * The most `input.insert.maxPerRun` may be. A run that is about to end reads
 * again for the messages inserted into it, and `RunSupervisor` allows 20 such
 * reads (`MAX_REREADS`), at least one for each inserted message.
 */
const MAX_INSERT_MAX_PER_RUN = 20;
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 100_000;
const DEFAULT_KEEP_RECENT_STEPS = 6;
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 30;
const DEFAULT_RUN_TIMEOUT_SECONDS = 300;
/**
 * The shortest life that `auth.backstageTokenExpiration` allows for the token
 * of a user. A run works with the token of the request that started it or
 * continued it after an approval, so it stays within this (V-06).
 */
const MAX_RUN_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20000;
const DEFAULT_LIVE_ENABLED = true;
const DEFAULT_LIVE_HOURS = 24;
const DEFAULT_LIVE_MAX_HOURS = 72;
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

/**
 * The limits on images. `maxBytesPerInput` must not be less than
 * `maxPerMessage` times `maxBytes`: the images of the first message of a run
 * are never left out of the input, so they must always fit.
 */
function readImageLimits(config: Config): ImageLimits {
  const defaults = DEFAULT_IMAGE_LIMITS;
  const limits: ImageLimits = {
    maxPerMessage: positiveInt(
      config,
      'input.images.maxPerMessage',
      defaults.maxPerMessage,
    ),
    maxBytes: positiveInt(config, 'input.images.maxBytes', defaults.maxBytes),
    maxBytesPerInput: positiveInt(
      config,
      'input.images.maxBytesPerInput',
      defaults.maxBytesPerInput,
    ),
    maxPendingPerSession: positiveInt(
      config,
      'input.images.maxPendingPerSession',
      defaults.maxPendingPerSession,
    ),
    tokensPerImage: positiveInt(
      config,
      'input.images.tokensPerImage',
      defaults.tokensPerImage,
    ),
  };
  if (limits.maxBytesPerInput < limits.maxPerMessage * limits.maxBytes) {
    throw new InputError(
      `aiChat.input.images.maxBytesPerInput (${
        limits.maxBytesPerInput
      }) must be at least maxPerMessage times maxBytes (${
        limits.maxPerMessage * limits.maxBytes
      })`,
    );
  }
  return limits;
}

/**
 * `sharing` and `live` may be left out. `enabled: false` is stored as false;
 * creating a share, which would refuse a live share then, is not in this
 * version. The hours are positive integers and the default is not longer than
 * the maximum.
 */
function readSharing(config: Config): AiChatConfig['sharing'] {
  const enabled =
    config.getOptionalBoolean('sharing.live.enabled') ?? DEFAULT_LIVE_ENABLED;
  const defaultHours = positiveInt(
    config,
    'sharing.live.defaultHours',
    DEFAULT_LIVE_HOURS,
  );
  const maxHours = positiveInt(
    config,
    'sharing.live.maxHours',
    DEFAULT_LIVE_MAX_HOURS,
  );
  if (defaultHours > maxHours) {
    throw new InputError(
      `sharing.live.defaultHours (${defaultHours}) must not be greater than sharing.live.maxHours (${maxHours})`,
    );
  }
  return { live: { enabled, defaultHours, maxHours } };
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
      images: config.getOptionalBoolean('llm.images') ?? false,
    },
    maxTurns: positiveInt(config, 'maxTurns', DEFAULT_MAX_TURNS),
    maxToolCallsPerRun: positiveInt(
      config,
      'maxToolCallsPerRun',
      DEFAULT_MAX_TOOL_CALLS_PER_RUN,
    ),
    context: {
      tokenBudget: positiveInt(
        config,
        'context.tokenBudget',
        DEFAULT_CONTEXT_TOKEN_BUDGET,
      ),
      keepRecentSteps: positiveInt(
        config,
        'context.keepRecentSteps',
        DEFAULT_KEEP_RECENT_STEPS,
      ),
    },
    runTimeoutSeconds: positiveInt(
      config,
      'runTimeoutSeconds',
      DEFAULT_RUN_TIMEOUT_SECONDS,
      1,
      MAX_RUN_TIMEOUT_SECONDS,
    ),
    input: {
      insertMaxPerRun: positiveInt(
        config,
        'input.insert.maxPerRun',
        DEFAULT_INSERT_MAX_PER_RUN,
        1,
        MAX_INSERT_MAX_PER_RUN,
      ),
      queueMaxMessages: positiveInt(
        config,
        'input.queue.maxMessages',
        DEFAULT_QUEUE_MAX_MESSAGES,
      ),
      images: readImageLimits(config),
    },
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
    sharing: readSharing(config),
    // 0 keeps every session. Any other integer is a number of days.
    retentionDays: positiveInt(
      config,
      'retention.days',
      DEFAULT_RETENTION_DAYS,
      0,
    ),
  };
}

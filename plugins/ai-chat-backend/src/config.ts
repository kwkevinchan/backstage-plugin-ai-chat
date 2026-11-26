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
  LOAD_SKILL_TOOL_ID,
  UPDATE_PLAN_TOOL_ID,
} from '@kwkevinchan/ai-chat-harness';
import { DEFAULT_MODEL_ID } from './application';
import {
  DEFAULT_IMAGE_LIMITS,
  DEFAULT_INSERT_MAX_PER_RUN,
  DEFAULT_QUEUE_MAX_MESSAGES,
  DEFAULT_RETENTION_DAYS,
  type ImageLimits,
  type ToolOutputRule,
} from './domain';

/** One model server (X-09): `aiChat.llm`, or an entry of `aiChat.models`. */
export interface ModelSettings {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  /** The model reads images (IN-05). */
  images: boolean;
  /** The model may ask for more than one tool in one answer. */
  parallelToolCalls: boolean;
  /** Model calls per minute, over all backends (P-06). No limit when absent. */
  requestsPerMinute?: number;
  /** Ask the server for the tokens of each streamed answer (O-01). */
  reportUsage: boolean;
}

export interface AiChatConfig {
  /** The model `default`. */
  llm: ModelSettings;
  /** The models of `aiChat.models`, by id; `default` is not among them. */
  models: ReadonlyMap<string, ModelSettings>;
  maxTurns: number;
  /** Most tool calls the model requests in one run. */
  maxToolCallsPerRun: number;
  /** Most tool calls the model requests in one step (P-05). */
  maxToolCallsPerStep: number;
  /** Read-only calls of one step that run at the same time (P-01). */
  readConcurrency: number;
  /** Seconds one tool call may take (P-02). */
  toolTimeoutSeconds: number;
  /** Runs one user may have going on at the same time (P-05). */
  runsPerUser: number;
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
  /** Lower limits and fields to hide for the output of actions (T-09). */
  toolOutput: ToolOutputRule[];
  /** Changes one user may make per minute (T-10). No limit when absent. */
  writesPerMinute?: number;
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
  /** Directories scanned for `SKILL.md` skills at startup (X-04, D-22). */
  skills: {
    directories: string[];
  };
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
const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 8;
const DEFAULT_READ_CONCURRENCY = 4;
const DEFAULT_TOOL_TIMEOUT_SECONDS = 60;
const DEFAULT_RUNS_PER_USER = 3;
/** The rule of the other ids of the plugin: agents, toolsets, skills. */
const MODEL_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i;
/** The width of `model_call_windows.model_id`. */
const MAX_MODEL_ID_LENGTH = 64;
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
const MAX_REDACT_FIELD_LENGTH = 200;
const MAX_WRITES_PER_MINUTE = 10000;
/** The tools of the core: `toolOutput` does not apply to them. */
const BUILT_IN_TOOL_IDS = [UPDATE_PLAN_TOOL_ID, LOAD_SKILL_TOOL_ID];

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

/**
 * Reads `aiChat.skills.directories`, defaulting to empty. Rejects non-array
 * values or blank entries so a typo stops the backend at startup.
 */
function readSkillsConfig(config: Config): AiChatConfig['skills'] {
  const directories = config.getOptionalStringArray('skills.directories') ?? [];
  for (const dir of directories) {
    if (dir.trim().length === 0) {
      throw new InputError(
        'aiChat.skills.directories must contain non-empty paths',
      );
    }
  }
  return { directories };
}

/**
 * One model server, at `key` of the `aiChat` section: `llm`, or
 * `models.<id>`.
 */
function readModel(config: Config, key: string): ModelSettings {
  const baseUrl = config.getString(`${key}.baseUrl`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new InputError(
      `aiChat.${key}.baseUrl must start with http:// or https://`,
    );
  }
  const rateKey = `${key}.requestsPerMinute`;
  return {
    baseUrl,
    apiKey: config.getOptionalString(`${key}.apiKey`),
    model: config.getString(`${key}.model`),
    timeoutMs:
      positiveInt(config, `${key}.timeoutSeconds`, DEFAULT_TIMEOUT_SECONDS) *
      1000,
    images: config.getOptionalBoolean(`${key}.images`) ?? false,
    parallelToolCalls:
      config.getOptionalBoolean(`${key}.parallelToolCalls`) ?? false,
    reportUsage: config.getOptionalBoolean(`${key}.reportUsage`) ?? true,
    ...(config.getOptional(rateKey) !== undefined && {
      requestsPerMinute: positiveInt(config, rateKey, 1),
    }),
  };
}

/**
 * `aiChat.models`: the models besides `aiChat.llm`, which is `default`. An id
 * follows the rule of the other ids; `default` is a duplicate.
 */
function readModels(config: Config): Map<string, ModelSettings> {
  const models = new Map<string, ModelSettings>();
  const block = config.getOptionalConfig('models');
  for (const id of block?.keys() ?? []) {
    const path = `aiChat.models.${id}`;
    if (!MODEL_ID.test(id) || id.length > MAX_MODEL_ID_LENGTH) {
      throw new InputError(
        `${path}: the id must start with a letter, may only have letters, digits, - and _ between them, and has at most ${MAX_MODEL_ID_LENGTH} characters`,
      );
    }
    if (id === DEFAULT_MODEL_ID) {
      throw new InputError(
        `${path}: the model default is aiChat.llm; use another id`,
      );
    }
    models.set(id, readModel(config, `models.${id}`));
  }
  return models;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `aiChat.toolOutput`: action ID patterns to `{ maxOutputChars, redact }`
 * (T-09). A limit may only be lower than `maxToolOutputChars`.
 */
function readToolOutput(
  value: unknown,
  maxToolOutputChars: number,
): ToolOutputRule[] {
  if (value === undefined) return [];
  if (!isObject(value)) {
    throw new InputError(
      'aiChat.toolOutput must map action ID patterns to an object',
    );
  }
  return Object.entries(value).map(([pattern, entry]) => {
    const path = `aiChat.toolOutput.${pattern}`;
    if (pattern.trim() === '') {
      throw new InputError(
        'aiChat.toolOutput: an action ID pattern must not be empty',
      );
    }
    if (BUILT_IN_TOOL_IDS.includes(pattern)) {
      throw new InputError(
        `${path}: toolOutput applies to actions, not to the built-in tool ${pattern}`,
      );
    }
    if (!isObject(entry)) {
      throw new InputError(`${path} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'maxOutputChars' && key !== 'redact') {
        throw new InputError(
          `${path}.${key} is not a setting; use maxOutputChars or redact`,
        );
      }
    }
    const max = entry.maxOutputChars;
    if (
      max !== undefined &&
      (typeof max !== 'number' ||
        !Number.isInteger(max) ||
        max < MIN_MAX_TOOL_OUTPUT_CHARS ||
        max > maxToolOutputChars)
    ) {
      throw new InputError(
        `${path}.maxOutputChars must be an integer from ${MIN_MAX_TOOL_OUTPUT_CHARS} to aiChat.maxToolOutputChars (${maxToolOutputChars}), got ${String(
          max,
        )}`,
      );
    }
    const redact = entry.redact ?? [];
    if (
      !Array.isArray(redact) ||
      redact.some(
        field =>
          typeof field !== 'string' ||
          field === '' ||
          field.length > MAX_REDACT_FIELD_LENGTH,
      )
    ) {
      throw new InputError(
        `${path}.redact must be a list of field names of 1 to ${MAX_REDACT_FIELD_LENGTH} characters`,
      );
    }
    return {
      pattern,
      ...(max !== undefined && { maxOutputChars: max }),
      redact: [...new Set(redact as string[])],
    };
  });
}

/** `aiChat.writesPerMinute` (T-10); `undefined` when it is not set. */
function readWritesPerMinute(config: Config): number | undefined {
  if (!config.has('writesPerMinute')) return undefined;
  const value = config.get('writesPerMinute');
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_WRITES_PER_MINUTE
  ) {
    throw new InputError(
      `aiChat.writesPerMinute must be an integer from 1 to ${MAX_WRITES_PER_MINUTE}, got ${String(
        value,
      )}`,
    );
  }
  return value;
}

/** Reads and checks the `aiChat` section of the configuration. */
export function readAiChatConfig(root: Config): AiChatConfig {
  const config = root.getConfig('aiChat');
  const runTimeoutSeconds = positiveInt(
    config,
    'runTimeoutSeconds',
    DEFAULT_RUN_TIMEOUT_SECONDS,
    1,
    MAX_RUN_TIMEOUT_SECONDS,
  );
  const maxToolOutputChars = positiveInt(
    config,
    'maxToolOutputChars',
    DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    MIN_MAX_TOOL_OUTPUT_CHARS,
  );
  return {
    llm: readModel(config, 'llm'),
    models: readModels(config),
    maxTurns: positiveInt(config, 'maxTurns', DEFAULT_MAX_TURNS),
    maxToolCallsPerRun: positiveInt(
      config,
      'maxToolCallsPerRun',
      DEFAULT_MAX_TOOL_CALLS_PER_RUN,
    ),
    maxToolCallsPerStep: positiveInt(
      config,
      'maxToolCallsPerStep',
      DEFAULT_MAX_TOOL_CALLS_PER_STEP,
    ),
    readConcurrency: positiveInt(
      config,
      'readConcurrency',
      DEFAULT_READ_CONCURRENCY,
    ),
    toolTimeoutSeconds: positiveInt(
      config,
      'toolTimeoutSeconds',
      DEFAULT_TOOL_TIMEOUT_SECONDS,
      1,
      MAX_RUN_TIMEOUT_SECONDS,
    ),
    runsPerUser: positiveInt(config, 'runsPerUser', DEFAULT_RUNS_PER_USER),
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
    runTimeoutSeconds,
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
    maxToolOutputChars,
    toolOutput: readToolOutput(
      config.getOptional('toolOutput'),
      maxToolOutputChars,
    ),
    writesPerMinute: readWritesPerMinute(config),
    sharing: readSharing(config),
    // 0 keeps every session. Any other integer is a number of days.
    retentionDays: positiveInt(
      config,
      'retention.days',
      DEFAULT_RETENTION_DAYS,
      0,
    ),
    skills: readSkillsConfig(config),
  };
}

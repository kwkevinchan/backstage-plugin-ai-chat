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

import { createHash } from 'node:crypto';
import type {
  BackstageCredentials,
  LoggerService,
} from '@backstage/backend-plugin-api';
// The only adapter that uses the actions service, which is still alpha (the
// assembly in plugin.ts passes it in). Check it again with every Backstage
// upgrade.
import type {
  ActionsService,
  ActionsServiceAction,
} from '@backstage/backend-plugin-api/alpha';
import {
  LOAD_SKILL_TOOL_ID,
  UPDATE_PLAN_TOOL_ID,
  decidePolicy,
  needsApproval,
  type Clock,
  type CallContext,
  type JsonObject,
  type JsonValue,
  type ToolCallItem,
  type ToolDescriptor,
  type ToolGateway,
  type ToolOutput,
  type ValidationResult,
} from '@kwkevinchan/ai-chat-harness';
import Ajv, { type ValidateFunction } from 'ajv';
import type { AgentCatalog } from '../../application/ports/AgentCatalog';
import type { WriteQuota } from '../../application/ports/WriteQuota';
import {
  redactFields,
  toolOutputLimits,
  type ToolOutputLimits,
  type ToolOutputRule,
} from '../../domain/toolOutput';
import {
  defaultToolsetIds,
  enabledTools,
  isEgress,
  unsafeAllows,
} from '../../domain/toolset';

/** @internal */
export type ActionsToolGatewayDeps = {
  actions: ActionsService;
  catalog: Pick<AgentCatalog, 'toolsets' | 'policy'>;
  logger: LoggerService;
  /**
   * The toolsets whose tools the session of the call offers now: switched on,
   * named by the agent and usable by the user (T-08). `undefined` means the
   * default toolsets.
   */
  enabledToolsets: (ctx: CallContext) => Promise<readonly string[] | undefined>;
  /** Most characters of the output of an action that are kept. */
  maxOutputChars: number;
  /** Lower limits and fields to hide, by action ID pattern (T-09). */
  toolOutput?: readonly ToolOutputRule[];
  /** The changes one user may make per minute (T-10). No limit when absent. */
  writeQuota?: { quota: WriteQuota; perMinute: number; clock: Clock };
};

const MAX_MESSAGE_CHARS = 2000;

/** The result of an output that could not be checked for fields to hide. */
export const REDACTION_FAILED_MESSAGE =
  'The output could not be checked for redaction, so it is not kept.';

/**
 * The tools of a session as the actions of the actions registry, run as the
 * user of the call.
 *
 * - A tool is read-only only when the action says `readOnly: true` (D-06).
 * - A tool is offered when it is in a toolset the session has switched on
 *   (T-02, T-11); a toolset marked `egress` makes its tools ask (T-04).
 * - `validate` checks the input against the input schema of the action (T-05).
 * - `execute` checks the call against the action and the policy as they are
 *   now: a tool that is no longer offered, that the policy denies, that asks
 *   for approval now although the call was stored without one, no longer read-only when the call was stored as
 *   read-only, or whose schema changed and no longer fits the stored input,
 *   does not run (T-06).
 * - The output loses the fields to hide, then is cut to the limit of the
 *   action (T-09). An output that cannot be checked is not kept.
 * - A call that is not read-only takes one change of the quota of the user
 *   right before the action runs; without one it does not run (T-10).
 *
 * @internal
 */
export class ActionsToolGateway implements ToolGateway {
  private readonly ajv = new Ajv({
    strict: false,
    validateFormats: false,
    allErrors: false,
    // The same `$id` in a second schema must not make `compile` throw.
    addUsedSchema: false,
  });
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly warned = new Set<string>();

  constructor(private readonly deps: ActionsToolGatewayDeps) {}

  async list(ctx: CallContext): Promise<ToolDescriptor[]> {
    const toolsets = await this.deps.catalog.toolsets();
    const all = await this.describeAll(ctx);
    await this.warnAboutUnsafeAllows(all);
    const choice =
      (await this.deps.enabledToolsets(ctx)) ?? defaultToolsetIds(toolsets);
    return enabledTools(all, toolsets, choice);
  }

  async validate(
    toolId: string,
    input: JsonObject,
    ctx: CallContext,
  ): Promise<ValidationResult> {
    const tool = (await this.list(ctx)).find(t => t.id === toolId);
    if (!tool) {
      return { valid: false, message: `The tool ${toolId} is not available.` };
    }
    return this.check(tool, input);
  }

  async execute(
    call: ToolCallItem,
    ctx: CallContext,
    opts: { signal: AbortSignal },
  ): Promise<ToolOutput> {
    const { signal } = opts;
    const credentials = credentialsOf(ctx.principal);
    throwIfAborted(signal);
    const tool = (await this.list(ctx)).find(t => t.id === call.toolId);
    // `list` takes time; do not start the action after an abort.
    throwIfAborted(signal);
    if (!tool) {
      return error(`The tool ${call.toolId} is not available.`);
    }
    if (call.readOnly === true && tool.readOnly !== true) {
      return error(
        `The tool ${call.toolId} is no longer read-only, so the stored call does not run.`,
      );
    }
    if (tool.schemaHash !== call.schemaHash) {
      const result = this.check(tool, call.input);
      if (!result.valid) {
        return error(
          `The schema of ${call.toolId} changed and the stored input no longer fits it: ${result.message}`,
        );
      }
    }

    // The policy decides at the time of the call and again before the run.
    const policy = decidePolicy(tool, await this.deps.catalog.policy());
    if (policy === 'deny') {
      return error(`The policy no longer allows ${call.toolId}.`);
    }
    if (policy !== 'allow' && !needsApproval(call)) {
      return error(
        `The policy now asks for approval of ${call.toolId}, and this call was stored without it, so it does not run.`,
      );
    }
    throwIfAborted(signal);
    if (call.readOnly !== true && !(await this.takeWrite(ctx))) {
      return error(
        `Not run: you reached the limit of ${this.deps.writeQuota?.perMinute} changes per minute. Try again in a minute.`,
      );
    }
    throwIfAborted(signal);

    let output: JsonValue | undefined;
    try {
      // The actions service takes no signal. Stop waiting when it aborts; the
      // action itself may still finish.
      const result = await abortable(
        this.deps.actions.invoke({
          id: call.toolId,
          input: call.input,
          credentials,
        }),
        signal,
      );
      output = result.output as JsonValue;
    } catch (e) {
      if (signal.aborted) throw e;
      return error(e instanceof Error ? e.message : String(e));
    }
    return limitToolResult(
      output === undefined ? { status: 'ok' } : { status: 'ok', output },
      this.limitsOf(call.toolId),
    );
  }

  /** The limit and the fields to hide for the output of a tool (T-09). */
  limitsOf(toolId: string): ToolOutputLimits {
    return toolOutputLimitsOf(
      toolId,
      this.deps.toolOutput ?? [],
      this.deps.maxOutputChars,
    );
  }

  /** Takes one change of the user of the call; `true` without a quota. */
  private async takeWrite(ctx: CallContext): Promise<boolean> {
    const settings = this.deps.writeQuota;
    if (!settings) return true;
    const userRef = (ctx.principal as { userRef?: unknown } | undefined)
      ?.userRef;
    if (typeof userRef !== 'string') {
      throw new Error('The call has no user.');
    }
    return settings.quota.tryTake(
      userRef,
      settings.perMinute,
      settings.clock.now(),
    );
  }

  private check(tool: ToolDescriptor, input: JsonObject): ValidationResult {
    let validate = this.validators.get(tool.schemaHash);
    if (!validate) {
      try {
        validate = this.ajv.compile(tool.inputSchema);
      } catch {
        return {
          valid: false,
          message: `The input schema of ${tool.id} cannot be checked.`,
        };
      }
      this.validators.set(tool.schemaHash, validate);
    }
    if (validate(input)) return { valid: true };
    return {
      valid: false,
      message: cut(this.ajv.errorsText(validate.errors, { dataVar: 'input' })),
    };
  }

  /** Every action the user may call, as a tool, before the toolsets narrow it. */
  private async describeAll(ctx: CallContext): Promise<ToolDescriptor[]> {
    const toolsets = await this.deps.catalog.toolsets();
    const { actions } = await this.deps.actions.list({
      credentials: credentialsOf(ctx.principal),
    });
    return (
      actions
        // An action that wants secrets cannot be called from a chat.
        .filter(action => !action.schema.secrets)
        .map(action => describe(action, isEgress(action.id, toolsets)))
    );
  }

  private async warnAboutUnsafeAllows(all: readonly ToolDescriptor[]) {
    const settings = await this.deps.catalog.policy();
    for (const id of unsafeAllows(all, settings)) {
      if (this.warned.has(id)) continue;
      this.warned.add(id);
      this.deps.logger.warn(
        `aiChat.policy sets ${id} to allow, but the action is not marked read-only; it still asks for approval`,
      );
    }
  }
}

function describe(
  action: ActionsServiceAction,
  egress: boolean,
): ToolDescriptor {
  const inputSchema = toInputSchema(action.schema.input);
  return {
    id: action.id,
    title: action.title,
    description: `${action.title}: ${action.description}`,
    inputSchema,
    schemaHash: hashOf(inputSchema),
    // Anything but `true` counts as not read-only.
    readOnly: action.attributes?.readOnly === true,
    ...(egress ? { egress: true } : {}),
  };
}

function toInputSchema(schema: unknown): JsonObject {
  if (
    typeof schema !== 'object' ||
    schema === null ||
    (schema as { type?: unknown }).type !== 'object'
  ) {
    return { type: 'object', properties: {} };
  }
  // Some servers refuse the `$schema` keyword, and ajv knows only draft-07.
  const { $schema: _ignored, ...rest } = schema as JsonObject;
  return rest;
}

function hashOf(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** JSON with the keys of every object in order, so equal schemas hash equal. */
function stableStringify(value: JsonValue | undefined): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function credentialsOf(principal: unknown): BackstageCredentials {
  const credentials =
    typeof principal === 'object' && principal !== null
      ? (principal as { credentials?: unknown }).credentials
      : undefined;
  if (typeof credentials !== 'object' || credentials === null) {
    throw new Error('The call has no credentials of the user.');
  }
  return credentials as BackstageCredentials;
}

function error(message: string): ToolOutput {
  return { status: 'error', message: cut(message) };
}

function cut(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_MESSAGE_CHARS)}...`;
}

/**
 * The limits of a tool: the built-in tools of the core keep the limit of the
 * installation and hide nothing; `toolOutput` is for actions.
 */
export function toolOutputLimitsOf(
  toolId: string,
  rules: readonly ToolOutputRule[],
  maxChars: number,
): ToolOutputLimits {
  if (toolId === UPDATE_PLAN_TOOL_ID || toolId === LOAD_SKILL_TOOL_ID) {
    return { maxChars, redact: [] };
  }
  return toolOutputLimits(toolId, rules, maxChars);
}

/**
 * `result` without the fields to hide, then with its output cut to the limit,
 * as `execute` treats the output of an action. A result whose output cannot
 * be checked becomes an `error` result without output. A result that needs
 * neither is returned as it is.
 */
export function limitToolResult(
  result: ToolOutput,
  limits: ToolOutputLimits,
): ToolOutput {
  if (result.output === undefined) return result;
  let redacted: JsonValue;
  try {
    redacted = redactFields(result.output, limits.redact);
  } catch {
    return { status: 'error', message: REDACTION_FAILED_MESSAGE };
  }
  const limited = limit(redacted, limits.maxChars);
  if (!limited.truncated) {
    return redacted === result.output
      ? result
      : { ...result, output: redacted };
  }
  return {
    ...result,
    output: limited.output,
    truncated: true,
    message: limited.message,
  };
}

/**
 * Always an object (the loop treats anything else as no result). A long output
 * becomes `{ text, originalLength }` whose serialized form is at most
 * `maxChars` characters.
 */
function limit(output: JsonValue | undefined, maxChars: number): ToolOutput {
  if (output === undefined) return { status: 'ok' };
  const json = JSON.stringify(output) ?? 'null';
  if (json.length <= maxChars) return { status: 'ok', output };
  // The longest prefix whose serialized form fits. The serialized length never
  // shrinks when the prefix grows, so a binary search finds it.
  const wrap = (length: number) => ({
    text: json.slice(0, length),
    originalLength: json.length,
  });
  const fits = (length: number) =>
    JSON.stringify(wrap(length)).length <= maxChars;
  let low = 0;
  let high = maxChars;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return {
    status: 'ok',
    output: wrap(low),
    truncated: true,
    message: `The output was cut: the stored output is at most ${maxChars} characters of ${json.length}.`,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('The call was aborted.');
  }
}

/** Settles with `promise`, or rejects as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (e) {
        reject(e);
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

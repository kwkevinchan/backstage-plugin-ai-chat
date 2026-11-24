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
  decidePolicy,
  needsApproval,
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
   * The toolsets the session of the call has switched on; `undefined` when it
   * has not chosen, which means the default toolsets.
   */
  enabledToolsets: (ctx: CallContext) => Promise<readonly string[] | undefined>;
  /** Most characters of the output of an action that are kept. */
  maxOutputChars: number;
};

const MAX_MESSAGE_CHARS = 2000;

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
    return limit(output, this.deps.maxOutputChars);
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

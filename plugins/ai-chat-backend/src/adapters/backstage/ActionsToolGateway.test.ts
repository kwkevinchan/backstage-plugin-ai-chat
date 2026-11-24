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

import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type {
  ActionsService,
  ActionsServiceAction,
} from '@backstage/backend-plugin-api/alpha';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import {
  decidePolicy,
  type CallContext,
  type PolicySettings,
  type ToolCallItem,
} from '@kwkevinchan/ai-chat-harness';
import type { AgentCatalog } from '../../application/ports/AgentCatalog';
import type { Toolset } from '../../domain/toolset';
import { ActionsToolGateway } from './ActionsToolGateway';

const credentials = mockCredentials.user('user:default/alice');
const ctx: CallContext = {
  sessionId: 's1',
  runId: 'r1',
  principal: { credentials },
};

const inputSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, count: { type: 'number' } },
  required: ['name'],
  additionalProperties: false,
} as const;

function action(
  id: string,
  extra: {
    attributes?: Record<string, unknown>;
    input?: unknown;
    secrets?: boolean;
  } = {},
): ActionsServiceAction {
  return {
    id,
    pluginId: id.split(':')[0],
    name: id.split(':')[1],
    title: `Title of ${id}`,
    description: `The action ${id}`,
    schema: {
      input: (extra.input ?? inputSchema) as any,
      output: { type: 'object' },
      ...(extra.secrets ? { secrets: { type: 'object' } } : {}),
    },
    attributes: (extra.attributes ?? {
      readOnly: true,
      destructive: false,
      idempotent: true,
    }) as any,
  };
}

class FakeActionsService implements ActionsService {
  actions: ActionsServiceAction[] = [];
  invoke = jest.fn(
    async (_opts: {
      id: string;
      input?: unknown;
      credentials: BackstageCredentials;
    }): Promise<{ output: any }> => ({ output: { ok: true } }),
  );
  list = jest.fn(async (_opts: { credentials: BackstageCredentials }) => ({
    actions: this.actions,
  }));
}

const toolset = (id: string, extra: Partial<Toolset> = {}): Toolset => ({
  id,
  actions: [`${id}:*`],
  exclude: [],
  default: false,
  egress: false,
  ...extra,
});

function setup(options: {
  toolsets?: Toolset[];
  policy?: PolicySettings;
  chosen?: string[];
  maxOutputChars?: number;
}) {
  const state = {
    chosen: options.chosen,
    toolsets: options.toolsets,
    policy: options.policy,
  };
  const actions = new FakeActionsService();
  const logger = mockServices.logger.mock();
  const catalog: AgentCatalog = {
    toolsets: async () =>
      state.toolsets ?? [toolset('catalog', { default: true })],
    policy: async () => state.policy ?? {},
  };
  const gateway = new ActionsToolGateway({
    actions,
    catalog,
    logger,
    enabledToolsets: async () => state.chosen,
    maxOutputChars: options.maxOutputChars ?? 1000,
  });
  return { actions, logger, gateway, state };
}

const callOf = (
  toolId: string,
  schemaHash: string,
  extra: Partial<ToolCallItem> = {},
  input: Record<string, unknown> = { name: 'x' },
) =>
  ({
    kind: 'tool_call',
    callId: 'c1',
    toolId,
    input,
    schemaHash,
    policy: 'allow',
    readOnly: true,
    step: 1,
    ...extra,
  } as unknown as ToolCallItem);

describe('ActionsToolGateway.list', () => {
  it('maps the action to a tool and passes the credentials of the user', async () => {
    const { actions, gateway } = setup({});
    actions.actions = [action('catalog:get')];
    const [tool] = await gateway.list(ctx);
    expect(actions.list).toHaveBeenCalledWith({ credentials });
    expect(tool).toMatchObject({
      id: 'catalog:get',
      description: 'Title of catalog:get: The action catalog:get',
      readOnly: true,
    });
    expect(tool.inputSchema).toMatchObject({ type: 'object' });
    expect(tool.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tool.egress).toBeUndefined();
  });

  it('counts an action without readOnly as not read-only (D-06)', async () => {
    const { actions, gateway } = setup({});
    actions.actions = [
      action('catalog:none', { attributes: {} }),
      action('catalog:false', { attributes: { readOnly: false } }),
      action('catalog:true', { attributes: { readOnly: true } }),
    ];
    const tools = await gateway.list(ctx);
    expect(tools.map(t => [t.id, t.readOnly])).toEqual([
      ['catalog:none', false],
      ['catalog:false', false],
      ['catalog:true', true],
    ]);
  });

  it('does not offer a tool of a toolset the session has not switched on (T-02)', async () => {
    const toolsets = [
      toolset('catalog', { default: true }),
      toolset('temporal'),
    ];
    const { actions, gateway } = setup({ toolsets });
    actions.actions = [action('catalog:get'), action('temporal:start')];
    expect((await gateway.list(ctx)).map(t => t.id)).toEqual(['catalog:get']);

    const chosen = setup({ toolsets, chosen: ['temporal'] });
    chosen.actions.actions = actions.actions;
    expect((await chosen.gateway.list(ctx)).map(t => t.id)).toEqual([
      'temporal:start',
    ]);
  });

  it('does not offer an action that is in no toolset, or that wants secrets', async () => {
    const { actions, gateway } = setup({});
    actions.actions = [
      action('catalog:get'),
      action('other:x'),
      action('catalog:secret', { secrets: true }),
    ];
    expect((await gateway.list(ctx)).map(t => t.id)).toEqual(['catalog:get']);
  });

  it('marks the tools of an egress toolset (T-04)', async () => {
    const { actions, gateway } = setup({
      toolsets: [toolset('web', { default: true, egress: true })],
    });
    actions.actions = [action('web:fetch')];
    const [tool] = await gateway.list(ctx);
    expect(tool.egress).toBe(true);
    expect(decidePolicy(tool, {})).toBe('ask');
  });

  it('gives the same hash to equal schemas and another to a changed one (T-06)', async () => {
    const { actions, gateway } = setup({});
    actions.actions = [
      action('catalog:a', {
        input: { type: 'object', properties: { a: {}, b: {} } },
      }),
      action('catalog:b', {
        input: { properties: { b: {}, a: {} }, type: 'object' },
      }),
      action('catalog:c', {
        input: { type: 'object', properties: { a: {} } },
      }),
    ];
    const [a, b, c] = await gateway.list(ctx);
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.schemaHash).not.toBe(c.schemaHash);
  });

  it('throws without credentials in the principal', async () => {
    const { gateway } = setup({});
    await expect(gateway.list({ ...ctx, principal: {} })).rejects.toThrow(
      'no credentials',
    );
  });
});

describe('policy of the offered tools', () => {
  it('asks for a tool that is not read-only even when the policy says allow (D-06, T-03)', async () => {
    const policy: PolicySettings = { byTool: { 'catalog:write': 'allow' } };
    const { actions, gateway, logger } = setup({ policy });
    actions.actions = [
      action('catalog:write', {
        attributes: { readOnly: false, destructive: true },
      }),
    ];
    const [tool] = await gateway.list(ctx);
    expect(decidePolicy(tool, policy)).toBe('ask');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('catalog:write'),
    );
  });

  it('warns once for a tool, not on every list', async () => {
    const policy: PolicySettings = { byTool: { 'catalog:write': 'allow' } };
    const { actions, gateway, logger } = setup({ policy });
    actions.actions = [action('catalog:write', { attributes: {} })];
    await gateway.list(ctx);
    await gateway.list(ctx);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a read-only tool that is set to allow', async () => {
    const policy: PolicySettings = { byTool: { 'catalog:get': 'allow' } };
    const { actions, gateway, logger } = setup({ policy });
    actions.actions = [action('catalog:get')];
    const [tool] = await gateway.list(ctx);
    expect(decidePolicy(tool, policy)).toBe('allow');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('ActionsToolGateway.validate', () => {
  async function gatewayWithTool() {
    const setupResult = setup({});
    setupResult.actions.actions = [action('catalog:get')];
    return setupResult.gateway;
  }

  it('accepts input that fits the schema', async () => {
    const gateway = await gatewayWithTool();
    expect(await gateway.validate('catalog:get', { name: 'a' }, ctx)).toEqual({
      valid: true,
    });
  });

  it('returns a message that names the problem (T-05)', async () => {
    const gateway = await gatewayWithTool();
    const missing = await gateway.validate('catalog:get', {}, ctx);
    expect(missing).toEqual({
      valid: false,
      message: expect.stringContaining("must have required property 'name'"),
    });
    const wrongType = await gateway.validate('catalog:get', { name: 5 }, ctx);
    expect(wrongType).toEqual({
      valid: false,
      message: expect.stringContaining('must be string'),
    });
    const extra = await gateway.validate(
      'catalog:get',
      { name: 'a', other: 1 },
      ctx,
    );
    expect(extra.valid).toBe(false);
  });

  it('rejects a tool that is not offered', async () => {
    const gateway = await gatewayWithTool();
    expect(await gateway.validate('catalog:missing', {}, ctx)).toEqual({
      valid: false,
      message: expect.stringContaining('not available'),
    });
  });

  it('rejects when the schema cannot be compiled', async () => {
    const { actions, gateway } = setup({});
    actions.actions = [
      action('catalog:get', {
        input: { type: 'object', properties: { a: { $ref: '#/nope' } } },
      }),
    ];
    const result = await gateway.validate('catalog:get', {}, ctx);
    expect(result).toEqual({
      valid: false,
      message: expect.stringContaining('cannot be checked'),
    });
  });

  it('accepts a schema that has a $schema keyword and a format', async () => {
    const { actions, gateway } = setup({});
    actions.actions = [
      action('catalog:get', {
        input: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { url: { type: 'string', format: 'uri' } },
        },
      }),
    ];
    expect(
      await gateway.validate(
        'catalog:get',
        { url: 'https://example.com' },
        ctx,
      ),
    ).toEqual({ valid: true });
  });
});

describe('ActionsToolGateway.execute', () => {
  async function prepared(options: Parameters<typeof setup>[0] = {}) {
    const s = setup(options);
    s.actions.actions = [action('catalog:get')];
    const [tool] = await s.gateway.list(ctx);
    return { ...s, hash: tool.schemaHash };
  }
  const signal = () => new AbortController().signal;

  it('invokes the action as the user and returns an ok object', async () => {
    const { actions, gateway, hash } = await prepared();
    const result = await gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: signal(),
    });
    expect(actions.invoke).toHaveBeenCalledWith({
      id: 'catalog:get',
      input: { name: 'x' },
      credentials,
    });
    expect(result).toEqual({ status: 'ok', output: { ok: true } });
  });

  it.each([
    ['a string', 'text'],
    ['a number', 3],
    ['null', null],
    ['an array', [1]],
  ])('returns an object when the action gives %s', async (_name, value) => {
    const { actions, gateway, hash } = await prepared();
    actions.invoke.mockResolvedValueOnce({ output: value });
    const result = await gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: signal(),
    });
    expect(typeof result).toBe('object');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ status: 'ok', output: value });
  });

  it('returns an ok object when the action gives nothing', async () => {
    const { actions, gateway, hash } = await prepared();
    actions.invoke.mockResolvedValueOnce({ output: undefined });
    expect(
      await gateway.execute(callOf('catalog:get', hash), ctx, {
        signal: signal(),
      }),
    ).toEqual({ status: 'ok' });
  });

  it('cuts a long output and says so', async () => {
    const { actions, gateway, hash } = await prepared({ maxOutputChars: 60 });
    actions.invoke.mockResolvedValueOnce({ output: { text: 'a'.repeat(100) } });
    const result = await gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: signal(),
    });
    expect(result).toMatchObject({
      status: 'ok',
      truncated: true,
      output: { text: expect.any(String), originalLength: 111 },
    });
    expect(JSON.stringify(result.output).length).toBeLessThanOrEqual(60);
  });

  it('turns a failure of the action into an error result', async () => {
    const { actions, gateway, hash } = await prepared();
    actions.invoke.mockRejectedValueOnce(new Error('boom'));
    expect(
      await gateway.execute(callOf('catalog:get', hash), ctx, {
        signal: signal(),
      }),
    ).toEqual({ status: 'error', message: 'boom' });
  });

  it('stops waiting when the signal aborts, and rejects', async () => {
    const { actions, gateway, hash } = await prepared();
    actions.invoke.mockReturnValueOnce(new Promise(() => {}));
    const controller = new AbortController();
    const pending = gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: controller.signal,
    });
    // Let the call reach the actions service before the abort.
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('does not invoke when the signal is already aborted', async () => {
    const { actions, gateway, hash } = await prepared();
    const controller = new AbortController();
    controller.abort();
    await expect(
      gateway.execute(callOf('catalog:get', hash), ctx, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(actions.invoke).not.toHaveBeenCalled();
  });

  describe('when the action changed after the call was stored (T-06)', () => {
    it('runs a call whose input still fits the new schema', async () => {
      const { actions, gateway } = await prepared();
      actions.actions = [
        action('catalog:get', {
          input: { type: 'object', properties: { name: { type: 'string' } } },
        }),
      ];
      const result = await gateway.execute(
        callOf('catalog:get', 'old-hash'),
        ctx,
        { signal: signal() },
      );
      expect(result.status).toBe('ok');
      expect(actions.invoke).toHaveBeenCalledTimes(1);
    });

    it('does not run a call whose input no longer fits', async () => {
      const { actions, gateway } = await prepared();
      actions.actions = [
        action('catalog:get', {
          input: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        }),
      ];
      const result = await gateway.execute(
        callOf('catalog:get', 'old-hash'),
        ctx,
        { signal: signal() },
      );
      expect(result.status).toBe('error');
      expect(result.message).toContain('changed');
      expect(result.message).toContain("must have required property 'id'");
      expect(actions.invoke).not.toHaveBeenCalled();
    });
  });

  it('does not run a call stored as read-only when the action no longer is', async () => {
    const { actions, gateway, hash } = await prepared();
    actions.actions = [action('catalog:get', { attributes: {} })];
    const result = await gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: signal(),
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('no longer read-only');
    expect(actions.invoke).not.toHaveBeenCalled();
  });

  it('does not run a tool that is no longer offered', async () => {
    const { actions, gateway, hash, state } = await prepared();
    state.chosen = [];
    const result = await gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: signal(),
    });
    expect(result.status).toBe('error');
    expect(actions.invoke).not.toHaveBeenCalled();
  });
});

describe('ActionsToolGateway.execute, more checks', () => {
  const signal = () => new AbortController().signal;
  async function prepared() {
    const s = setup({});
    s.actions.actions = [action('catalog:get')];
    const [tool] = await s.gateway.list(ctx);
    return { ...s, hash: tool.schemaHash };
  }

  it('does not invoke when the signal aborts while the tools are listed', async () => {
    const { actions, gateway, hash } = await prepared();
    const controller = new AbortController();
    actions.list.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { actions: actions.actions };
    });
    const pending = gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(actions.invoke).not.toHaveBeenCalled();
  });

  it('does not run a call that the policy denies now', async () => {
    const { actions, gateway, hash, state } = await prepared();
    state.policy = { byTool: { 'catalog:get': 'deny' } };
    const result = await gateway.execute(callOf('catalog:get', hash), ctx, {
      signal: signal(),
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('policy');
    expect(actions.invoke).not.toHaveBeenCalled();
  });

  it('does not run a call stored as ask when the policy denies it after the approval', async () => {
    const { actions, gateway, hash, state } = await prepared();
    state.policy = { byTool: { 'catalog:get': 'deny' } };
    const result = await gateway.execute(
      callOf('catalog:get', hash, { policy: 'ask' }),
      ctx,
      { signal: signal() },
    );
    expect(result.status).toBe('error');
    expect(actions.invoke).not.toHaveBeenCalled();
  });

  it('runs an approved call that the policy still asks for', async () => {
    const { actions, gateway, hash, state } = await prepared();
    state.policy = { byTool: { 'catalog:get': 'ask' } };
    const result = await gateway.execute(
      callOf('catalog:get', hash, { policy: 'ask' }),
      ctx,
      { signal: signal() },
    );
    expect(result.status).toBe('ok');
    expect(actions.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not run a call stored without approval when the tool now sends data out', async () => {
    const { actions, gateway, hash, state } = await prepared();
    state.toolsets = [toolset('catalog', { default: true, egress: true })];
    const result = await gateway.execute(
      callOf('catalog:get', hash, { policy: 'allow' }),
      ctx,
      { signal: signal() },
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('approval');
    expect(actions.invoke).not.toHaveBeenCalled();
  });

  it('keeps the serialized output of a cut result within the limit', async () => {
    const s = setup({ maxOutputChars: 50 });
    s.actions.actions = [action('catalog:get')];
    const [tool] = await s.gateway.list(ctx);
    s.actions.invoke.mockResolvedValueOnce({ output: { t: '"'.repeat(200) } });
    const result = await s.gateway.execute(
      callOf('catalog:get', tool.schemaHash),
      ctx,
      { signal: signal() },
    );
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.output).length).toBeLessThanOrEqual(50);
  });

  it('validates two tools whose schemas have the same $id', async () => {
    const { actions, gateway } = setup({});
    const withId = (extra: object) => ({
      $id: 'https://example.com/same',
      type: 'object',
      ...extra,
    });
    actions.actions = [
      action('catalog:a', {
        input: withId({ properties: { a: { type: 'string' } } }),
      }),
      action('catalog:b', {
        input: withId({ properties: { b: { type: 'number' } } }),
      }),
    ];
    expect(await gateway.validate('catalog:a', { a: 'x' }, ctx)).toEqual({
      valid: true,
    });
    expect(await gateway.validate('catalog:b', { b: 1 }, ctx)).toEqual({
      valid: true,
    });
  });
});

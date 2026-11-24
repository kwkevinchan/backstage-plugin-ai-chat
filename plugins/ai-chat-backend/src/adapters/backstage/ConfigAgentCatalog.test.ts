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

import { mockServices } from '@backstage/backend-test-utils';
import { decidePolicy } from '@kwkevinchan/ai-chat-harness';
import { ConfigAgentCatalog } from './ConfigAgentCatalog';

function catalogFor(aiChat: unknown) {
  const logger = mockServices.logger.mock();
  const catalog = new ConfigAgentCatalog(
    mockServices.rootConfig({ data: { aiChat } as any }),
    logger,
  );
  return { catalog, logger };
}

describe('ConfigAgentCatalog', () => {
  it('reads the toolsets (T-01, D-24)', async () => {
    const { catalog, logger } = catalogFor({
      toolsets: {
        catalog: { actions: ['catalog:*'], default: true, title: 'Catalog' },
        web: { actions: ['web:*'], egress: true },
      },
    });
    expect(await catalog.toolsets()).toEqual([
      {
        id: 'catalog',
        title: 'Catalog',
        actions: ['catalog:*'],
        exclude: [],
        default: true,
        egress: false,
      },
      {
        id: 'web',
        title: undefined,
        actions: ['web:*'],
        exclude: [],
        default: false,
        egress: true,
      },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('turns the flat policy into byTool', async () => {
    const { catalog } = catalogFor({
      policy: { 'temporal:terminate-workflow': 'deny', 'catalog:get': 'allow' },
    });
    const settings = await catalog.policy();
    expect(settings).toEqual({
      byTool: { 'temporal:terminate-workflow': 'deny', 'catalog:get': 'allow' },
    });
    const tool = {
      id: 'temporal:terminate-workflow',
      description: '',
      inputSchema: {},
      schemaHash: 'h',
      readOnly: true,
    };
    expect(decidePolicy(tool, settings)).toBe('deny');
  });

  it('has no policy settings without a policy block', async () => {
    const { catalog } = catalogFor({});
    expect(await catalog.policy()).toEqual({});
  });

  it('rejects a policy value that is not allow, ask or deny', () => {
    expect(() => catalogFor({ policy: { 'a:b': 'auto' } })).toThrow(
      'aiChat.policy.a:b must be allow, ask or deny',
    );
  });

  it('rejects a toolset without actions or with a bad id', () => {
    expect(() => catalogFor({ toolsets: { a: { actions: [] } } })).toThrow(
      'aiChat.toolsets.a.actions must not be empty',
    );
    expect(() =>
      catalogFor({ toolsets: { 'a b': { actions: ['x'] } } }),
    ).toThrow('the id may only have');
  });

  it('offers every action in one default toolset when nothing is configured', async () => {
    const { catalog, logger } = catalogFor({});
    expect(await catalog.toolsets()).toEqual([
      {
        id: 'default',
        actions: ['*'],
        exclude: [],
        default: true,
        egress: false,
      },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('turns the deprecated include and exclude into one toolset and warns', async () => {
    const { catalog, logger } = catalogFor({
      actions: { include: ['catalog:*'], exclude: ['catalog:delete'] },
    });
    expect(await catalog.toolsets()).toEqual([
      {
        id: 'default',
        actions: ['catalog:*'],
        exclude: ['catalog:delete'],
        default: true,
        egress: false,
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
    );
  });

  it('ignores the deprecated lists when toolsets are set, and warns', async () => {
    const { catalog, logger } = catalogFor({
      actions: { include: ['x:*'] },
      toolsets: { a: { actions: ['a:*'] } },
    });
    expect((await catalog.toolsets()).map(t => t.id)).toEqual(['a']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored'),
    );
  });
});

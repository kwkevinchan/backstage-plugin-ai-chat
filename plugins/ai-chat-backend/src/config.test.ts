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
import type { JsonObject } from '@backstage/types';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { ConfigAgentCatalog } from './adapters/backstage/ConfigAgentCatalog';
import { readAiChatConfig } from './config';

const llm = { baseUrl: 'https://llm.test/v1/', model: 'm' };

describe('readAiChatConfig', () => {
  it('reads the settings and applies the defaults', () => {
    const config = readAiChatConfig(
      mockServices.rootConfig({ data: { aiChat: { llm } } }),
    );
    expect(config).toEqual({
      llm: {
        baseUrl: 'https://llm.test/v1',
        apiKey: undefined,
        model: 'm',
        timeoutMs: 120000,
        images: false,
        parallelToolCalls: false,
        reportUsage: true,
      },
      models: new Map(),
      maxTurns: 10,
      maxToolCallsPerRun: 30,
      maxToolCallsPerStep: 8,
      readConcurrency: 4,
      toolTimeoutSeconds: 60,
      runsPerUser: 3,
      runTimeoutSeconds: 300,
      context: { tokenBudget: 100000, keepRecentSteps: 6 },
      input: {
        insertMaxPerRun: 5,
        queueMaxMessages: 5,
        images: {
          maxPerMessage: 4,
          maxBytes: 5242880,
          maxBytesPerInput: 20971520,
          maxPendingPerSession: 12,
          tokensPerImage: 1600,
        },
      },
      systemPrompt: undefined,
      actions: { include: [], exclude: [] },
      maxToolOutputChars: 20000,
      sharing: { live: { enabled: true, defaultHours: 24, maxHours: 72 } },
      retentionDays: 90,
      skills: { directories: [] },
    });
  });

  it('reads the models (X-09): llm is default, models are the others, with their capabilities and rate limits', () => {
    const config = readAiChatConfig(
      mockServices.rootConfig({
        data: {
          aiChat: {
            llm: { ...llm, parallelToolCalls: true, requestsPerMinute: 30 },
            models: {
              small: {
                baseUrl: 'https://small.test/v1/',
                apiKey: 'k',
                model: 's',
                images: true,
                timeoutSeconds: 10,
              },
            },
          },
        },
      }),
    );
    expect(config.llm).toMatchObject({
      parallelToolCalls: true,
      requestsPerMinute: 30,
    });
    expect([...config.models]).toEqual([
      [
        'small',
        {
          baseUrl: 'https://small.test/v1',
          apiKey: 'k',
          model: 's',
          timeoutMs: 10000,
          images: true,
          parallelToolCalls: false,
          reportUsage: true,
        },
      ],
    ]);
  });

  it('reads reportUsage of each model (O-01): true by default, and a value that is not a boolean stops the backend', () => {
    const read = (aiChat: Record<string, unknown>) =>
      readAiChatConfig(
        mockServices.rootConfig({ data: { aiChat: { llm, ...aiChat } } }),
      );
    const config = read({
      llm: { ...llm, reportUsage: false },
      models: {
        small: { ...llm, reportUsage: false },
        large: { ...llm },
      },
    });
    expect(config.llm.reportUsage).toBe(false);
    expect(config.models.get('small')?.reportUsage).toBe(false);
    expect(config.models.get('large')?.reportUsage).toBe(true);
    expect(() => read({ llm: { ...llm, reportUsage: 3 } })).toThrow(
      'reportUsage',
    );
  });

  it('refuses aiChat.models.default, a bad model id, a bad baseUrl and a requestsPerMinute that is not a positive integer', () => {
    const read = (aiChat: Record<string, unknown>) => () =>
      readAiChatConfig(
        mockServices.rootConfig({ data: { aiChat: { llm, ...aiChat } } }),
      );
    expect(read({ models: { default: llm } })).toThrow(
      'aiChat.models.default: the model default is aiChat.llm; use another id',
    );
    expect(read({ models: { '1x': llm } })).toThrow(
      'aiChat.models.1x: the id must start with a letter',
    );
    const long = `m${'x'.repeat(64)}`;
    expect(read({ models: { [long]: llm } })).toThrow(
      'has at most 64 characters',
    );
    expect(() =>
      read({ models: { [`m${'x'.repeat(63)}`]: llm } })(),
    ).not.toThrow();
    expect(read({ models: { small: { ...llm, baseUrl: 'ftp://x' } } })).toThrow(
      'aiChat.models.small.baseUrl must start with http:// or https://',
    );
    expect(
      read({ models: { small: { ...llm, requestsPerMinute: 0 } } }),
    ).toThrow('models.small.requestsPerMinute must be a positive integer');
    expect(read({ llm: { ...llm, requestsPerMinute: 1.5 } })).toThrow(
      'llm.requestsPerMinute must be a positive integer',
    );
  });

  it('reads the limits of a step, of the tool calls and of the runs of a user (P-02, P-05)', () => {
    const read = (aiChat: Record<string, unknown>) =>
      readAiChatConfig(
        mockServices.rootConfig({ data: { aiChat: { llm, ...aiChat } } }),
      );
    expect(
      read({
        maxToolCallsPerStep: 2,
        readConcurrency: 1,
        toolTimeoutSeconds: 600,
        runsPerUser: 1,
      }),
    ).toMatchObject({
      maxToolCallsPerStep: 2,
      readConcurrency: 1,
      toolTimeoutSeconds: 600,
      runsPerUser: 1,
    });
    expect(() => read({ maxToolCallsPerStep: 0 })).toThrow(
      'maxToolCallsPerStep must be a positive integer',
    );
    expect(() => read({ readConcurrency: 0 })).toThrow(
      'readConcurrency must be a positive integer',
    );
    expect(() => read({ toolTimeoutSeconds: 601 })).toThrow(
      'toolTimeoutSeconds must be at most 600',
    );
    expect(() => read({ runsPerUser: -1 })).toThrow(
      'runsPerUser must be a positive integer',
    );
  });

  it('reads sharing.live and refuses a life that is not a positive integer or longer than the maximum', () => {
    const read = (sharing?: JsonObject) =>
      readAiChatConfig(
        mockServices.rootConfig({
          data: {
            aiChat: { llm, ...(sharing === undefined ? {} : { sharing }) },
          },
        }),
      ).sharing;
    expect(read()).toEqual({
      live: { enabled: true, defaultHours: 24, maxHours: 72 },
    });
    expect(read({})).toEqual({
      live: { enabled: true, defaultHours: 24, maxHours: 72 },
    });
    expect(read({ live: { enabled: false } })).toEqual({
      live: { enabled: false, defaultHours: 24, maxHours: 72 },
    });
    expect(read({ live: { defaultHours: 12, maxHours: 48 } })).toEqual({
      live: { enabled: true, defaultHours: 12, maxHours: 48 },
    });
    expect(() => read({ live: { defaultHours: 0 } })).toThrow(
      /sharing\.live\.defaultHours must be a positive integer/,
    );
    expect(() => read({ live: { defaultHours: 1.5 } })).toThrow(
      /sharing\.live\.defaultHours must be a positive integer/,
    );
    expect(() => read({ live: { maxHours: 1.5 } })).toThrow(
      /sharing\.live\.maxHours must be a positive integer/,
    );
    expect(() => read({ live: { defaultHours: 80 } })).toThrow(
      /sharing\.live\.defaultHours \(80\) must not be greater than sharing\.live\.maxHours \(72\)/,
    );
    expect(() => read({ live: { maxHours: 10 } })).toThrow(
      /sharing\.live\.defaultHours \(24\) must not be greater than sharing\.live\.maxHours \(10\)/,
    );
  });

  it('reads the limits of the inserted and the queued messages, and refuses a value that is not a positive integer', () => {
    const read = (input: JsonObject) =>
      readAiChatConfig(
        mockServices.rootConfig({ data: { aiChat: { llm, input } } }),
      ).input;
    expect(
      read({ insert: { maxPerRun: 2 }, queue: { maxMessages: 9 } }),
    ).toMatchObject({ insertMaxPerRun: 2, queueMaxMessages: 9 });
    expect(() => read({ insert: { maxPerRun: 0 } })).toThrow(
      /input\.insert\.maxPerRun must be a positive integer/,
    );
    expect(() => read({ insert: { maxPerRun: 21 } })).toThrow(
      /input\.insert\.maxPerRun must be at most 20/,
    );
    expect(() => read({ queue: { maxMessages: 1.5 } })).toThrow(
      /input\.queue\.maxMessages must be a positive integer/,
    );
  });

  describe('images (IN-01, IN-05, IN-06)', () => {
    const readImages = (images: JsonObject | undefined, llmImages?: boolean) =>
      readAiChatConfig(
        mockServices.rootConfig({
          data: {
            aiChat: {
              llm: {
                ...llm,
                ...(llmImages !== undefined && { images: llmImages }),
              },
              input: { images: images ?? {} },
            },
          },
        }),
      );

    it('leaves the model without images unless the configuration says it reads them', () => {
      expect(readImages(undefined).llm.images).toBe(false);
      expect(readImages(undefined, true).llm.images).toBe(true);
      expect(readImages(undefined, false).llm.images).toBe(false);
    });

    it('reads the limits, and has the defaults of the specification', () => {
      expect(readImages({}).input.images).toEqual({
        maxPerMessage: 4,
        maxBytes: 5 * 1024 * 1024,
        maxBytesPerInput: 20 * 1024 * 1024,
        maxPendingPerSession: 12,
        tokensPerImage: 1600,
      });
      expect(
        readImages({
          maxPerMessage: 2,
          maxBytes: 1000,
          maxBytesPerInput: 5000,
          maxPendingPerSession: 3,
          tokensPerImage: 800,
        }).input.images,
      ).toEqual({
        maxPerMessage: 2,
        maxBytes: 1000,
        maxBytesPerInput: 5000,
        maxPendingPerSession: 3,
        tokensPerImage: 800,
      });
    });

    it('refuses a limit that is not a positive integer', () => {
      for (const key of [
        'maxPerMessage',
        'maxBytes',
        'maxBytesPerInput',
        'maxPendingPerSession',
        'tokensPerImage',
      ]) {
        expect(() => readImages({ [key]: 0 })).toThrow(
          new RegExp(`input\\.images\\.${key} must be a positive integer`),
        );
        expect(() => readImages({ [key]: 1.5 })).toThrow(
          new RegExp(`input\\.images\\.${key} must be a positive integer`),
        );
      }
    });

    it('stops the backend when maxBytesPerInput is less than maxPerMessage times maxBytes, and takes it when it is equal', () => {
      expect(() =>
        readImages({
          maxPerMessage: 4,
          maxBytes: 1000,
          maxBytesPerInput: 3999,
        }),
      ).toThrow(
        /maxBytesPerInput \(3999\) must be at least maxPerMessage times maxBytes \(4000\)/,
      );
      expect(
        readImages({ maxPerMessage: 4, maxBytes: 1000, maxBytesPerInput: 4000 })
          .input.images.maxBytesPerInput,
      ).toBe(4000);
      // The defaults satisfy it: 4 times 5 MB is 20 MB.
      expect(() => readImages({})).not.toThrow();
      expect(() => readImages({ maxPerMessage: 5 })).toThrow(/at least/);
    });
  });

  it('reads everything that can be set', () => {
    const config = readAiChatConfig(
      mockServices.rootConfig({
        data: {
          aiChat: {
            llm: { ...llm, apiKey: 'k', timeoutSeconds: 5 },
            maxTurns: 3,
            maxToolCallsPerRun: 7,
            runTimeoutSeconds: 600,
            systemPrompt: 'Be brief.',
            actions: { include: ['a:*'], exclude: ['a:b'] },
            maxToolOutputChars: 150,
          },
        },
      }),
    );
    expect(config).toMatchObject({
      llm: { apiKey: 'k', timeoutMs: 5000 },
      maxTurns: 3,
      maxToolCallsPerRun: 7,
      runTimeoutSeconds: 600,
      systemPrompt: 'Be brief.',
      actions: { include: ['a:*'], exclude: ['a:b'] },
      maxToolOutputChars: 150,
    });
  });

  it('refuses a missing section, a bad URL and a bad number', () => {
    expect(() =>
      readAiChatConfig(mockServices.rootConfig({ data: {} })),
    ).toThrow(/aiChat/);
    expect(() =>
      readAiChatConfig(
        mockServices.rootConfig({
          data: { aiChat: { llm: { ...llm, baseUrl: 'ftp://x' } } },
        }),
      ),
    ).toThrow(/http/);
    expect(() =>
      readAiChatConfig(
        mockServices.rootConfig({ data: { aiChat: { llm, maxTurns: 0 } } }),
      ),
    ).toThrow(/maxTurns/);
    expect(() =>
      readAiChatConfig(
        mockServices.rootConfig({
          data: { aiChat: { llm, maxToolOutputChars: 99 } },
        }),
      ),
    ).toThrow(/maxToolOutputChars must be an integer of at least 100/);

    expect(
      readAiChatConfig(
        mockServices.rootConfig({
          data: { aiChat: { llm, retention: { days: 30 } } },
        }),
      ).retentionDays,
    ).toBe(30);
    expect(
      readAiChatConfig(
        mockServices.rootConfig({
          data: { aiChat: { llm, retention: { days: 0 } } },
        }),
      ).retentionDays,
    ).toBe(0);

    for (const [key, value] of [
      ['runTimeoutSeconds', 601],
      ['runTimeoutSeconds', 0],
      ['maxToolCallsPerRun', 0],
    ] as const) {
      expect(() =>
        readAiChatConfig(
          mockServices.rootConfig({
            data: { aiChat: { llm, [key]: value } },
          }),
        ),
      ).toThrow(new RegExp(key));
    }
    for (const days of [-1, 1.5]) {
      expect(() =>
        readAiChatConfig(
          mockServices.rootConfig({
            data: { aiChat: { llm, retention: { days } } },
          }),
        ),
      ).toThrow(/retention\.days/);
    }

    expect(
      readAiChatConfig(
        mockServices.rootConfig({
          data: { aiChat: { llm, skills: { directories: ['./skills'] } } },
        }),
      ).skills,
    ).toEqual({ directories: ['./skills'] });

    expect(() =>
      readAiChatConfig(
        mockServices.rootConfig({
          data: { aiChat: { llm, skills: { directories: ['   '] } } },
        }),
      ),
    ).toThrow(/aiChat\.skills\.directories/);
  });
});

describe('the configuration in the READMEs', () => {
  // The first YAML block of each README is the example of the settings. It is
  // what a reader pastes, so the backend has to accept it.
  const readme = (name: string) =>
    readFileSync(resolve(__dirname, '../../..', name), 'utf8');
  const exampleOf = (text: string) => {
    const block = /```yaml\n([\s\S]*?)```/.exec(
      text.slice(text.indexOf('## ')),
    );
    return parse(block![1]);
  };

  it.each(['README.md', 'README.zh-TW.md'])(
    'is accepted by the backend: %s',
    async name => {
      const data = exampleOf(readme(name));
      const root = mockServices.rootConfig({ data });
      const logger = mockServices.logger.mock();

      const config = readAiChatConfig(root);
      expect(config).toMatchObject({
        llm: { model: 'gpt-4o-mini', images: false },
        maxTurns: 10,
        maxToolCallsPerRun: 30,
        runTimeoutSeconds: 300,
        context: { tokenBudget: 100000, keepRecentSteps: 6 },
        input: {
          insertMaxPerRun: 5,
          queueMaxMessages: 5,
          images: {
            maxPerMessage: 4,
            maxBytes: 5242880,
            maxBytesPerInput: 20971520,
            maxPendingPerSession: 12,
            tokensPerImage: 1600,
          },
        },
        maxToolOutputChars: 20000,
        sharing: { live: { enabled: true, defaultHours: 24, maxHours: 72 } },
        retentionDays: 90,
      });
      const catalog = new ConfigAgentCatalog(root, logger);
      expect((await catalog.toolsets()).map(t => t.id)).toEqual(
        expect.arrayContaining(['catalog', 'web']),
      );
      expect((await catalog.policy()).byTool).toMatchObject({
        'catalog:get-entity': 'allow',
        'temporal:terminate-workflow': 'deny',
      });
      const sre = await catalog.agent('sre');
      expect(sre.title).toBe('SRE Agent');
      expect(sre.systemPrompt).toContain('Rules that always apply');
      expect(sre.systemPrompt).toContain('example.com');
      expect(sre.toolsets).toEqual(expect.arrayContaining(['catalog']));
      expect(sre.skills).toEqual(['deploy-failure', 'rollback']);
      expect(sre.model).toBe('default');
      expect(sre.planning).toBe('required');
      expect(sre.limits).toEqual({
        maxSteps: 8,
        maxToolCallsPerRun: 20,
        runTimeoutSeconds: 300,
      });
      const fallback = await catalog.agent('default');
      expect(fallback.title).toBe('Backstage Agent');
      expect(fallback.toolsets).toEqual(['catalog']);
      expect(fallback.systemPrompt).toContain('Rules that always apply');
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});

describe('usage.zh-TW.html', () => {
  it('loads no external resource', () => {
    const html = readFileSync(
      resolve(__dirname, '../../../docs/design/usage.zh-TW.html'),
      'utf8',
    );
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import\b/i);
  });
});

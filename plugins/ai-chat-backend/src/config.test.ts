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
      },
      maxTurns: 10,
      maxToolCallsPerRun: 30,
      runTimeoutSeconds: 300,
      systemPrompt: undefined,
      actions: { include: [], exclude: [] },
      maxToolOutputChars: 20000,
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
  });
});

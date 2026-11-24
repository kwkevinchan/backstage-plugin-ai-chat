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

import type { ModelChunk, ModelInput } from '@kwkevinchan/ai-chat-harness';
import type { LlmClient, LlmRequest } from './OpenAiCompatibleClient';
import { OpenAiCompatibleModelClient } from './OpenAiCompatibleModelClient';

const input: ModelInput = {
  system: 'sys',
  tools: [
    {
      id: 'catalog:get-entity',
      description: 'Get an entity',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
      },
      schemaHash: 'h',
      readOnly: true,
    },
  ],
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { callId: 'c1', toolId: 'catalog:get-entity', input: { a: 1 } },
        { callId: 'c2', toolId: 'old:gone', input: {} },
      ],
    },
    { role: 'tool', callId: 'c1', content: '{"ok":true}' },
    { role: 'tool', callId: 'c2', content: 'gone' },
  ],
};

async function collect(stream: AsyncIterable<ModelChunk>) {
  const out: ModelChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const signal = new AbortController().signal;

describe('OpenAiCompatibleModelClient', () => {
  it('sends names the API accepts, and maps the answer back to tool ids', async () => {
    let seen: LlmRequest | undefined;
    const llm: LlmClient = {
      async complete(request) {
        seen = request;
        request.onText?.('Hel');
        request.onText?.('lo');
        return {
          content: 'Hello',
          toolCalls: [
            {
              id: 'call_1',
              name: 'catalog_get-entity',
              arguments: '{"name":"x"}',
            },
          ],
        };
      },
    };
    const chunks = await collect(
      new OpenAiCompatibleModelClient(llm).stream(input, { signal }),
    );
    expect(chunks).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      {
        type: 'tool_call',
        modelCallId: 'call_1',
        toolId: 'catalog:get-entity',
        input: { name: 'x' },
      },
    ]);
    expect(seen!.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'catalog_get-entity',
          description: 'Get an entity',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(seen!.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'catalog_get-entity', arguments: '{"a":1}' },
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'old_gone', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c2', content: 'gone' },
    ]);
  });

  it('passes arguments that are not JSON as text, and empty ones as an empty object', async () => {
    const llm: LlmClient = {
      async complete() {
        return {
          content: '',
          toolCalls: [
            { id: 'a', name: 'catalog_get-entity', arguments: '{oops' },
            { id: 'b', name: 'catalog_get-entity', arguments: '' },
            { id: 'c', name: 'unknown_tool', arguments: '{}' },
          ],
        };
      },
    };
    const chunks = await collect(
      new OpenAiCompatibleModelClient(llm).stream(input, { signal }),
    );
    expect(chunks.map(c => (c as any).input)).toEqual(['{oops', {}, {}]);
    expect((chunks[2] as any).toolId).toBe('unknown_tool');
  });

  it('throws what the call threw', async () => {
    const llm: LlmClient = {
      async complete() {
        throw new Error('server down');
      },
    };
    await expect(
      collect(new OpenAiCompatibleModelClient(llm).stream(input, { signal })),
    ).rejects.toThrow('server down');
  });

  it('makes two tool ids that give one name unique', async () => {
    let seen: LlmRequest | undefined;
    const llm: LlmClient = {
      async complete(request) {
        seen = request;
        return { content: '', toolCalls: [] };
      },
    };
    const tool = (id: string) => ({ ...input.tools[0], id });
    await collect(
      new OpenAiCompatibleModelClient(llm).stream(
        { system: '', messages: [], tools: [tool('a:b'), tool('a_b')] },
        { signal },
      ),
    );
    expect(seen!.tools.map(t => t.function.name).sort()).toEqual([
      'a_b',
      'a_b_2',
    ]);
  });
});

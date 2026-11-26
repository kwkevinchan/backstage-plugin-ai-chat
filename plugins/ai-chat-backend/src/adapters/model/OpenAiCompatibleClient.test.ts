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

import { LlmServer, sseBody, startLlmServer } from '../../__testUtils__';
import { LlmError, OpenAiCompatibleClient } from './OpenAiCompatibleClient';

const chunk = (delta: unknown) => ({ choices: [{ index: 0, delta }] });

describe('OpenAiCompatibleClient', () => {
  let server: LlmServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function client(
    llm: Partial<ConstructorParameters<typeof OpenAiCompatibleClient>[0]> = {},
  ) {
    return new OpenAiCompatibleClient({
      baseUrl: server!.url,
      model: 'test-model',
      timeoutMs: 2000,
      ...llm,
    });
  }

  it('streams text and sends the request of the Chat Completions API', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Hel' }),
        chunk({ content: 'lo' }),
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]),
    }));
    const parts: string[] = [];
    const result = await client({ apiKey: 'secret-key' }).complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'a_b',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      onText: t => parts.push(t),
    });
    expect(result).toEqual({ content: 'Hello', toolCalls: [] });
    expect(parts).toEqual(['Hel', 'lo']);
    expect(server.requests[0].headers.authorization).toBe('Bearer secret-key');
    expect(server.requests[0].body).toMatchObject({
      model: 'test-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'a_b' } }],
    });
  });

  it('sends parallel_tool_calls only with tools, when the model declares it (X-09)', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([chunk({ content: 'x' })]),
    }));
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'a', description: 'd', parameters: {} },
      },
    ];
    await client().complete({ messages: [], tools, parallelToolCalls: true });
    await client().complete({
      messages: [],
      tools: [],
      parallelToolCalls: true,
    });
    await client().complete({ messages: [], tools, parallelToolCalls: false });
    expect(server.requests.map(r => r.body.parallel_tool_calls)).toEqual([
      true,
      undefined,
      undefined,
    ]);
  });

  it('sends no key and no tools when there are none', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([chunk({ content: 'x' })]),
    }));
    await client().complete({ messages: [], tools: [] });
    expect(server.requests[0].headers.authorization).toBeUndefined();
    expect(server.requests[0].body.tools).toBeUndefined();
  });

  it('puts together a tool call that arrives in pieces', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'demo_x', arguments: '' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"na' } }] }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: 'me":1}' } }],
        }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              function: { name: 'demo_y', arguments: '{}' },
            },
          ],
        }),
      ]),
    }));
    const result = await client().complete({ messages: [], tools: [] });
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'demo_x', arguments: '{"name":1}' },
      { id: 'call_b', name: 'demo_y', arguments: '{}' },
    ]);
  });

  it('gives an ID to a tool call that has none', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([
        chunk({ tool_calls: [{ function: { name: 'x', arguments: '{}' } }] }),
      ]),
    }));
    const result = await client().complete({ messages: [], tools: [] });
    expect(result.toolCalls[0].id).toMatch(/^call_/);
  });

  it('replaces a call ID that is too long, in a streamed and a whole answer', async () => {
    const long = 'c'.repeat(300);
    server = await startLlmServer((_body, index) =>
      index === 0
        ? {
            body: sseBody([
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: long,
                    function: { name: 'x', arguments: '{}' },
                  },
                ],
              }),
            ]),
          }
        : {
            type: 'application/json',
            body: JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      { id: long, function: { name: 'x', arguments: '{}' } },
                    ],
                  },
                },
              ],
            }),
          },
    );
    for (let i = 0; i < 2; i++) {
      const result = await client().complete({ messages: [], tools: [] });
      expect(result.toolCalls[0].id).toMatch(/^call_[0-9a-f-]{36}$/);
    }
  });

  it('adds a piece without index and ID to the last call', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([
        chunk({
          tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{"n"' } }],
        }),
        chunk({ tool_calls: [{ function: { arguments: ':1}' } }] }),
        chunk({
          tool_calls: [{ id: 'b', function: { name: 'y', arguments: '{}' } }],
        }),
      ]),
    }));
    const result = await client().complete({ messages: [], tools: [] });
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'x', arguments: '{"n":1}' },
      { id: 'b', name: 'y', arguments: '{}' },
    ]);
  });

  it('reads an answer that is not streamed', async () => {
    server = await startLlmServer(() => ({
      type: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'x', arguments: '{"a":1}' },
                },
              ],
            },
          },
        ],
      }),
    }));
    expect(await client().complete({ messages: [], tools: [] })).toEqual({
      content: '',
      toolCalls: [{ id: 'c1', name: 'x', arguments: '{"a":1}' }],
    });
  });

  it('asks for the usage of a streamed answer and reads it from the last chunk (O-01)', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([
        chunk({ content: 'Hi' }),
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          choices: [],
          usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
        },
      ]),
    }));
    const result = await client().complete({ messages: [], tools: [] });
    expect(result).toEqual({
      content: 'Hi',
      toolCalls: [],
      usage: { inputTokens: 42, outputTokens: 7 },
    });
    expect(server.requests[0].body.stream_options).toEqual({
      include_usage: true,
    });
  });

  it('sends no stream_options when reportUsage is false, and gives no usage when the server sends none', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([chunk({ content: 'Hi' })]),
    }));
    const result = await client({ reportUsage: false }).complete({
      messages: [],
      tools: [],
    });
    expect(result).toEqual({ content: 'Hi', toolCalls: [] });
    expect(server.requests[0].body).not.toHaveProperty('stream_options');
  });

  it('reads the usage of an answer that is not streamed, and ignores counts that are not counts', async () => {
    const answers = [
      { prompt_tokens: 10, completion_tokens: 2 },
      { prompt_tokens: -1, completion_tokens: 2 },
      { prompt_tokens: 'many', completion_tokens: 2 },
    ];
    let n = 0;
    server = await startLlmServer(() => ({
      type: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: answers[n++],
      }),
    }));
    const results = [];
    for (let i = 0; i < answers.length; i++) {
      results.push(await client().complete({ messages: [], tools: [] }));
    }
    expect(results.map(r => r.usage)).toEqual([
      { inputTokens: 10, outputTokens: 2 },
      undefined,
      undefined,
    ]);
  });

  it('reports a refusal without the key', async () => {
    server = await startLlmServer(() => ({
      status: 401,
      type: 'application/json',
      body: '{"error":"bad key"}',
    }));
    const error = await client({ apiKey: 'secret-key' })
      .complete({ messages: [], tools: [] })
      .catch(e => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.status).toBe(401);
    expect(error.message).toBe(
      'The model server answered 401: {"error":"bad key"}',
    );
    expect(error.message).not.toContain('secret-key');
  });

  it('reports an error that arrives inside the stream', async () => {
    server = await startLlmServer(() => ({
      body: sseBody([{ error: { message: 'overloaded' } }]),
    }));
    await expect(
      client().complete({ messages: [], tools: [] }),
    ).rejects.toThrow('The model server reported an error: overloaded');
  });

  it('reports a server that cannot be reached, without the key', async () => {
    const unreachable = new OpenAiCompatibleClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'secret-key',
      model: 'm',
      timeoutMs: 2000,
    });
    const error = await unreachable
      .complete({ messages: [], tools: [] })
      .catch(e => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toMatch(/^Could not reach the model server/);
    expect(error.message).not.toContain('secret-key');
  });

  it('stops when the caller aborts', async () => {
    server = await startLlmServer(() => ({ body: sseBody([]) }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      client().complete({ messages: [], tools: [], signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
});

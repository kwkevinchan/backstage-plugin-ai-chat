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

/**
 * A scripted OpenAI-compatible server for development, tests and the smoke
 * test, so that nothing needs an API key. It answers
 * `POST /v1/chat/completions` (streamed or not) with fixed behavior that
 * depends on the last message of the conversation:
 *
 *   user: "list ..."          -> calls the tool that ends in `list-services`
 *   user: "restart <name>"    -> calls the tool that ends in `restart-service`
 *   user: "catalog ..."       -> calls the tool that ends in `query-catalog-entities`
 *   user: "loop ..."          -> calls `list-services` again after every result
 *   tool result               -> a sentence that repeats part of the result
 *   tool result of a refusal  -> says that nothing was done
 *   anything else             -> a short help text
 *
 * Usage:
 *   node scripts/fake-llm.mjs            # listens on FAKE_LLM_PORT (default 4010)
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function findTool(tools, suffix) {
  return (tools ?? []).find(t => t.function?.name?.endsWith(suffix))?.function
    ?.name;
}

/** The scripted reply for a request body: `{ text }` or `{ call }`. */
export function scriptedReply(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const tools = body.tools ?? [];
  const call = (suffix, args) => {
    const name = findTool(tools, suffix);
    return name
      ? { call: { name, arguments: JSON.stringify(args) } }
      : { text: `The tool ${suffix} is not available.` };
  };

  if (last?.role === 'tool') {
    const content = String(last.content ?? '');
    if (content.startsWith('The user rejected')) {
      return {
        text: 'Understood. I did not run that action, so nothing changed.',
      };
    }
    if (content.startsWith('The user sent a new message')) {
      return { text: 'That action did not run.' };
    }
    if (content.startsWith('Error:')) {
      return { text: `The action failed. ${content.slice(0, 200)}` };
    }
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (/^loop/i.test(String(lastUser?.content ?? ''))) {
      return call('list-services', {});
    }
    return {
      text: `Here is the result of the action: ${content.slice(0, 400)}`,
    };
  }

  const text = String(last?.content ?? '');
  if (/^list/i.test(text)) return call('list-services', {});
  const restart = /^restart\s+([\w-]+)/i.exec(text);
  if (restart) return call('restart-service', { name: restart[1] });
  if (/^catalog/i.test(text))
    return call('query-catalog-entities', { limit: 3 });
  if (/^loop/i.test(text)) return call('list-services', {});
  return {
    text: 'I can **list** the services, **restart** a service by name, or read the **catalog**. Try: `list services` or `restart payments`.',
  };
}

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}');
  const reply = scriptedReply(body);

  if (body.stream === false) {
    const message = reply.call
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_fake_1',
              type: 'function',
              function: reply.call,
            },
          ],
        }
      : { role: 'assistant', content: reply.text };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message }] }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(chunk({ role: 'assistant', content: '' }));
  if (reply.call) {
    const id = `call_${Math.random().toString(36).slice(2, 10)}`;
    send(
      chunk({
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name: reply.call.name, arguments: '' },
          },
        ],
      }),
    );
    const args = reply.call.arguments;
    const half = Math.ceil(args.length / 2);
    for (const piece of [args.slice(0, half), args.slice(half)]) {
      send(
        chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }),
      );
    }
    send(chunk({}, 'tool_calls'));
  } else {
    for (const word of reply.text.split(/(?<= )/)) {
      send(chunk({ content: word }));
      await wait(25);
    }
    send(chunk({}, 'stop'));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function startFakeLlm(port = 4010) {
  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      res.writeHead(500).end(String(error));
    });
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FAKE_LLM_PORT ?? 4010);
  await startFakeLlm(port);
  console.log(`Fake LLM listening on http://127.0.0.1:${port}/v1`);
}

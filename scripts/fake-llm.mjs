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
 *   user: "restart both"      -> calls `restart-service` for two services in one answer
 *   user: "slow restart <n>"  -> calls the tool that ends in `restart-service-slowly`
 *   user: "where ..."         -> says what the model was told about the page of the user
 *   user: "story"             -> a long text that arrives word by word
 *   user: "catalog ..."       -> calls the tool that ends in `query-catalog-entities`
 *   user: "loop ..."          -> calls `list-services` again after every result
 *   user: "hold [n]"          -> a text that arrives word by word for n seconds (default 5),
 *                                then lists the user messages it was given, so a test has
 *                                time to add a message while the model is still answering
 *   user: "fail"              -> after 3 seconds, an HTTP 500 (the model call fails)
 *   user: "also <text>"       -> says that it got the addition
 *   user with images          -> says how many images it got and their types and sizes
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

const STORY = Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(' ');

/**
 * A message of the user may start with one line that says where the user is
 * ("The user is on the page of ..."), then an empty line, then the text.
 */
function splitContext(content) {
  const match = /^(The user is on [^\n]*)\n\n([\s\S]*)$/.exec(content);
  return match
    ? { context: match[1], text: match[2] }
    : { context: undefined, text: content };
}

/**
 * The text of the content of a message: the string, or the text parts of a
 * content array (a message with images has one).
 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('\n');
}

/** The images of a content array: the media type and the bytes of each data URL. */
function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(part => part?.type === 'image_url')
    .map(part => {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url?.url);
      return match
        ? { mediaType: match[1], bytes: Buffer.from(match[2], 'base64').length }
        : { mediaType: 'unknown', bytes: 0 };
    });
}

function findTool(tools, suffix) {
  return (tools ?? []).find(t => t.function?.name?.endsWith(suffix))?.function
    ?.name;
}

/** The user messages of a request, without the line about the page. */
function userTexts(messages) {
  return messages
    .filter(m => m.role === 'user')
    .map(m => splitContext(contentText(m.content)).text);
}

/**
 * The scripted reply for a request body: `{ text }` or `{ calls }`. A reply
 * may also have `wordDelayMs` (the pause between words) and `failAfterMs` (an
 * HTTP 500 after that time, instead of a reply).
 */
export function scriptedReply(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const tools = body.tools ?? [];
  const call = (suffix, ...argsList) => {
    const name = findTool(tools, suffix);
    return name
      ? {
          calls: argsList.map(args => ({
            name,
            arguments: JSON.stringify(args),
          })),
        }
      : { text: `The tool ${suffix} is not available.` };
  };

  if (last?.role === 'tool') {
    const content = String(last.content ?? '');
    if (content.includes('"status":"denied"')) {
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
    if (/^loop/i.test(splitContext(contentText(lastUser?.content)).text)) {
      return call('list-services', {});
    }
    return {
      text: `Here is the result of the action: ${content.slice(0, 400)}`,
    };
  }

  const { context, text } = splitContext(contentText(last?.content));
  const images = imagesOf(last?.content);
  if (images.length > 0) {
    const list = images.map(i => `${i.mediaType} ${i.bytes} bytes`).join(', ');
    return { text: `I can see ${images.length} image(s): ${list}.` };
  }
  if (/^where/i.test(text)) {
    return {
      text: context
        ? `You asked where you are. ${context}`
        : 'I do not know where you are.',
    };
  }
  if (/^list/i.test(text)) return call('list-services', {});
  if (/^restart both/i.test(text)) {
    return call('restart-service', { name: 'search' }, { name: 'billing' });
  }
  const slow = /^slow restart\s+([\w-]+)/i.exec(text);
  if (slow) return call('restart-service-slowly', { name: slow[1] });
  const restart = /^restart\s+([\w-]+)/i.exec(text);
  if (restart) return call('restart-service', { name: restart[1] });
  if (/^story/i.test(text)) return { text: STORY };
  const hold = /^hold(?:\s+(\d+))?/i.exec(text);
  if (hold) {
    const seconds = Number(hold[1] ?? 5);
    const words = Array.from(
      { length: seconds * 10 },
      (_, i) => `held${i + 1}`,
    );
    return {
      text: `${words.join(' ')} [saw: ${userTexts(messages).join(' | ')}]`,
      wordDelayMs: 100,
    };
  }
  if (/^fail/i.test(text)) return { failAfterMs: 3000 };
  const also = /^also\s+(.*)$/is.exec(text);
  if (also) return { text: `Got your addition: ${also[1]}` };
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

  if (reply.failAfterMs) {
    await wait(reply.failAfterMs);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { message: 'The scripted model failed.' } }),
    );
    return;
  }

  if (body.stream === false) {
    const message = reply.calls
      ? {
          role: 'assistant',
          content: null,
          tool_calls: reply.calls.map((call, index) => ({
            id: `call_fake_${index + 1}`,
            type: 'function',
            function: call,
          })),
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
  if (reply.calls) {
    for (const [index, call] of reply.calls.entries()) {
      const id = `call_${Math.random().toString(36).slice(2, 10)}`;
      send(
        chunk({
          tool_calls: [
            {
              index,
              id,
              type: 'function',
              function: { name: call.name, arguments: '' },
            },
          ],
        }),
      );
      const half = Math.ceil(call.arguments.length / 2);
      for (const piece of [
        call.arguments.slice(0, half),
        call.arguments.slice(half),
      ]) {
        send(
          chunk({ tool_calls: [{ index, function: { arguments: piece } }] }),
        );
      }
    }
    send(chunk({}, 'tool_calls'));
  } else {
    for (const word of reply.text.split(/(?<= )/)) {
      send(chunk({ content: word }));
      await wait(reply.wordDelayMs ?? (reply.text === STORY ? 40 : 25));
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

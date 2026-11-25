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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  chatPaths,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { createRouter } from '../adapters/http';

const spec = parse(readFileSync(resolve(__dirname, 'openapi.yaml'), 'utf8'));

/** `METHOD /path` of every route of an Express router, in OpenAPI form. */
function routesOf(router: any): string[] {
  const routes: string[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const openApiPath = layer.route.path.replace(
      /:([A-Za-z]+)(\([^)]*\))?/g,
      '{$1}',
    );
    for (const method of Object.keys(layer.route.methods)) {
      routes.push(`${method.toUpperCase()} ${openApiPath}`);
    }
  }
  return routes.sort();
}

function operationsOf(): string[] {
  const operations: string[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (item[method]) operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations.sort();
}

describe('the OpenAPI spec', () => {
  it('describes every route of the router, and no other', () => {
    const router = createRouter({ useCases: {}, logger: {} } as any);
    expect(operationsOf()).toEqual(routesOf(router));
  });

  it('has the message limit of the code', () => {
    expect(
      spec.paths['/sessions/{id}/runs'].post.requestBody.content[
        'application/json'
      ].schema.properties.text.maxLength,
    ).toBe(MAX_MESSAGE_LENGTH);
  });

  it('has the title limit of the code', () => {
    expect(
      spec.paths['/sessions/{id}'].patch.requestBody.content['application/json']
        .schema.properties.title.maxLength,
    ).toBe(MAX_TITLE_LENGTH);
  });

  it('has a schema for every kind of item of the log', () => {
    const kinds = spec.components.schemas.ChatItem.oneOf.map((ref: any) => {
      const name = ref.$ref.split('/').pop();
      const schema = spec.components.schemas[name];
      return schema.allOf[1].properties.kind.const;
    });
    expect(kinds.sort()).toEqual(
      [
        'agent_message',
        'approval',
        'note',
        'plan_update',
        'summary',
        'tool_call',
        'tool_result',
        'tool_started',
        'user_message',
      ].sort(),
    );
  });

  it('has the route of every path of the shared definitions', () => {
    const paths = [
      chatPaths.sessions(),
      chatPaths.session('{id}'),
      chatPaths.runs('{id}'),
      chatPaths.attachments('{id}'),
      chatPaths.attachment('{id}', '{attachmentId}'),
      chatPaths.inputConfig(),
      chatPaths.insertMessage('{id}', '{runId}'),
      chatPaths.cancelRun('{id}', '{runId}'),
      chatPaths.queue('{id}'),
      chatPaths.queueOrder('{id}'),
      chatPaths.queueResume('{id}'),
      chatPaths.queuedMessage('{id}', '{queuedId}'),
      chatPaths.insertQueuedMessage('{id}', '{queuedId}'),
      chatPaths.decision('{id}', '{callId}'),
      chatPaths.resume('{id}'),
      chatPaths.stream('{id}'),
      chatPaths.tools('{id}'),
      chatPaths.toolsets(),
    ].map(path => decodeURIComponent(path));
    expect(paths.sort()).toEqual(Object.keys(spec.paths).sort());
  });
});

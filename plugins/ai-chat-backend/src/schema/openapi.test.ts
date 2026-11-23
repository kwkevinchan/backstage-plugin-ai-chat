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
import { MAX_MESSAGE_LENGTH } from '../common';
import { createRouter } from '../routes/router';

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
    const router = createRouter({} as any);
    expect(operationsOf()).toEqual(routesOf(router));
  });

  it('has the message limit of the code', () => {
    expect(
      spec.paths['/conversations/{id}/messages'].post.requestBody.content[
        'application/json'
      ].schema.properties.content.maxLength,
    ).toBe(MAX_MESSAGE_LENGTH);
  });

  it('has an event schema for every event type of the code', () => {
    const types = spec.components.schemas.ChatEvent.oneOf.map(
      (e: any) => e.properties.type.const,
    );
    expect(types.sort()).toEqual(
      [
        'approval_required',
        'assistant_message',
        'done',
        'error',
        'notice',
        'text_delta',
        'tool_call',
        'tool_result',
        'user_message',
      ].sort(),
    );
  });
});

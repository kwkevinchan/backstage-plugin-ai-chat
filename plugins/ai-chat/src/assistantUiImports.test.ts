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

// This test reads the source files; it runs in Node, never in a browser.
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative, sep } from 'path';

// Only `adapters/assistantUi/` and `ui/` may import `@assistant-ui/*`, so that
// an upgrade of assistant-ui changes these two folders and nothing else.

const root = __dirname;
const allowed = ['adapters/assistantUi/', 'ui/'];

const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](@assistant-ui\/[^'"]*)['"]/g;

/** The `@assistant-ui/*` modules that a source text imports. */
function assistantUiImports(source: string): string[] {
  return [...source.matchAll(IMPORT)].map(match => match[1]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('imports of assistant-ui', () => {
  it('finds every form of import', () => {
    expect(
      assistantUiImports(
        [
          "import { a } from '@assistant-ui/react';",
          "import type { B } from '@assistant-ui/react';",
          "import '@assistant-ui/react-markdown/styles.css';",
          "export { c } from '@assistant-ui/core';",
          "const d = await import('@assistant-ui/store');",
          "const e = require('@assistant-ui/tap');",
          "import { f } from 'assistant-ui-like';",
        ].join('\n'),
      ),
    ).toEqual([
      '@assistant-ui/react',
      '@assistant-ui/react',
      '@assistant-ui/react-markdown/styles.css',
      '@assistant-ui/core',
      '@assistant-ui/store',
      '@assistant-ui/tap',
    ]);
  });

  it('are only in adapters/assistantUi/ and ui/', () => {
    const files = sourceFiles(root);
    const offending = files
      .map(file => relative(root, file).split(sep).join('/'))
      .filter(file => !allowed.some(dir => file.startsWith(dir)))
      // The samples of the first test are text, not imports.
      .filter(file => file !== 'assistantUiImports.test.ts')
      .filter(
        file =>
          assistantUiImports(readFileSync(join(root, file), 'utf8')).length,
      );
    expect(files.length).toBeGreaterThan(20);
    expect(offending).toEqual([]);
  });

  it('are used in both folders', () => {
    const using = (dir: string) =>
      sourceFiles(join(root, dir)).some(
        file => assistantUiImports(readFileSync(file, 'utf8')).length > 0,
      );
    expect(using('adapters/assistantUi')).toBe(true);
    expect(using('ui')).toBe(true);
  });
});

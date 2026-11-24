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

import { ESLint } from 'eslint';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// Lints sample code as if it were a file of the package, with the real
// configuration of the package (.eslintrc.js). The samples are never written
// to disk; the imports they use point at files that exist.

const packageDir = resolve(__dirname, '..');
const eslint = new ESLint({ cwd: packageDir });

async function lint(file: string, code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: join(packageDir, file),
  });
  return result.messages.map(m => ({ rule: m.ruleId, message: m.message }));
}

describe('dependency rules of the core', () => {
  it('accepts imports that point inward', async () => {
    expect(
      await lint(
        'src/application/example.ts',
        "import {} from '../domain/index';\n\nexport {};\n",
      ),
    ).toEqual([]);
    expect(
      await lint(
        'src/domain/example.ts',
        "import {} from './index';\n\nexport {};\n",
      ),
    ).toEqual([]);
    expect(
      await lint(
        'src/testing/example.ts',
        "import {} from '../application/index';\nimport {} from '../domain/index';\n\nexport {};\n",
      ),
    ).toEqual([]);
  });

  describe.each([
    ['src/index.ts'],
    ['src/domain/example.ts'],
    ['src/application/example.ts'],
    ['src/testing/example.ts'],
    ['src/domain/example.test.ts'],
    ['src/testing/example.test.ts'],
    ['src/index.test.ts'],
  ])('%s', file => {
    it.each([
      ['@backstage/errors'],
      ['@backstage/backend-plugin-api'],
      ['@backstage/errors/something'],
    ])('rejects an import of %s', async source => {
      const messages = await lint(file, `import {} from '${source}';\n`);
      expect(messages.map(m => m.rule)).toContain('no-restricted-imports');
    });
  });

  it.each([['src/domain/example.ts'], ['src/application/example.ts']])(
    '%s does not import express or knex',
    async file => {
      for (const source of ['express', 'knex', 'express/lib/router']) {
        const messages = await lint(file, `import {} from '${source}';\n`);
        expect(messages.map(m => m.rule)).toContain('no-restricted-imports');
      }
    },
  );

  it('rejects an import of application from domain', async () => {
    const messages = await lint(
      'src/domain/example.ts',
      "import {} from '../application/index';\n\nexport {};\n",
    );
    expect(messages.map(m => m.rule)).toContain('import/no-restricted-paths');
  });

  it.each([
    ['src/domain/example.ts', '../testing/index'],
    ['src/application/example.ts', '../testing/index'],
  ])('%s rejects an import of %s', async (file, source) => {
    const messages = await lint(
      file,
      `import {} from '${source}';\n\nexport {};\n`,
    );
    expect(messages.map(m => m.rule)).toContain('import/no-restricted-paths');
  });
});

describe('the circles are an allow list', () => {
  it.each([
    ['src/domain/example.ts', '../index'],
    ['src/domain/example.ts', '..'],
    ['src/application/example.ts', '../index'],
    ['src/application/example.ts', '..'],
  ])('%s rejects an import of %s (the entry point)', async (file, source) => {
    const messages = await lint(
      file,
      `import {} from '${source}';\n\nexport {};\n`,
    );
    expect(messages.map(m => m.rule)).toContain('import/no-restricted-paths');
  });

  it.each([
    ['src/application/example.test.ts', '../testing/index'],
    ['src/application/example.test.ts', '../domain/index'],
    ['src/domain/example.test.ts', '../testing/index'],
    ['src/testing/example.test.ts', '../application/index'],
  ])('lets the test file %s import %s', async (file, source) => {
    expect(
      await lint(file, `import {} from '${source}';\n\nexport {};\n`),
    ).toEqual([]);
  });

  it('still keeps domain from importing application in a test file', async () => {
    const messages = await lint(
      'src/domain/example.test.ts',
      "import {} from '../application/index';\n\nexport {};\n",
    );
    expect(messages.map(m => m.rule)).toContain('import/no-restricted-paths');
  });

  it.each([['src/domain/example.ts'], ['src/application/example.ts']])(
    '%s does not use fetch',
    async file => {
      const messages = await lint(
        file,
        "export const f = () => fetch('https://example.com');\n",
      );
      expect(messages.map(m => m.rule)).toContain('no-restricted-globals');
    },
  );
});

describe('the domain circle is pure', () => {
  it.each([
    [
      'an async function',
      'export async function f() {\n  return 1;\n}\n',
      'no async function',
    ],
    [
      'an async arrow function',
      'export const f = async () => 1;\n',
      'no async function',
    ],
    ['await', 'export const f = async () => {\n  await 1;\n};\n', 'no await'],
    ['a Promise type', 'export type P = Promise<number>;\n', 'no Promise'],
    [
      'fetch',
      "export const f = () => fetch('https://example.com');\n",
      'instead of fetch',
    ],
  ])('rejects %s', async (_name, code, text) => {
    const messages = await lint('src/domain/example.ts', code);
    expect(messages.map(m => m.message).join('\n')).toContain(text);
  });

  it.each([
    ['fs'],
    ['fs/promises'],
    ['node:fs'],
    ['node:crypto'],
    ['path'],
    ['crypto'],
    ['http'],
    ['child_process'],
  ])('rejects an import of %s', async source => {
    const messages = await lint(
      'src/domain/example.ts',
      `import {} from '${source}';\n`,
    );
    expect(messages.map(m => m.rule)).toContain('no-restricted-imports');
  });

  it('accepts plain synchronous code', async () => {
    expect(
      await lint(
        'src/domain/example.ts',
        'export const double = (n: number): number => n * 2;\n',
      ),
    ).toEqual([]);
  });

  it('leaves the application circle free to be asynchronous', async () => {
    expect(
      await lint(
        'src/application/example.ts',
        'export async function run(): Promise<number> {\n  return 1;\n}\n',
      ),
    ).toEqual([]);
  });
});

describe('manifest of the core', () => {
  it('lists no @backstage package as a runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    );
    const runtime = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    expect(runtime.filter(name => name.startsWith('@backstage/'))).toEqual([]);
  });
});

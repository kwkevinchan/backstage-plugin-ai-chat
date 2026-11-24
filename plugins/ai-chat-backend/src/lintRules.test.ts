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

const rules = (messages: { rule: string | null }[]) =>
  messages.map(m => m.rule);

// The rule that keeps `adapters/http` and `adapters/persistence` apart is in
// the configuration, but the plugin only applies a zone whose folder exists.
// The test for it comes with `adapters/http`.

describe('dependency rules of the host', () => {
  it('accepts imports that point inward', async () => {
    expect(
      await lint(
        'src/application/example.ts',
        "import {} from '../domain/index';\nimport {} from './ports/index';\n\nexport {};\n",
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
        'src/adapters/model/example.ts',
        "import {} from '../../application/index';\nimport {} from '../../domain/index';\n\nexport {};\n",
      ),
    ).toEqual([]);
  });

  it('accepts the harness package and its testing entry in the inner circles', async () => {
    expect(
      await lint(
        'src/application/example.test.ts',
        "import {} from '@kwkevinchan/ai-chat-harness';\nimport {} from '@kwkevinchan/ai-chat-harness/testing';\n\nexport {};\n",
      ),
    ).toEqual([]);
  });

  it.each([
    ['src/domain/example.ts', '../application/index'],
    ['src/domain/example.test.ts', '../application/index'],
    ['src/domain/example.ts', '../adapters/persistence/index'],
    ['src/domain/example.ts', '../plugin'],
    ['src/application/example.ts', '../adapters/persistence/index'],
    ['src/application/example.test.ts', '../adapters/persistence/index'],
    ['src/application/example.ts', '../adapters/backstage/AuditorAuditLog'],
    ['src/application/example.ts', '../config'],
    ['src/application/example.ts', '../plugin'],
    ['src/application/example.ts', '../chat/ChatService'],
  ])('%s rejects an import of %s', async (file, source) => {
    const messages = await lint(
      file,
      `import {} from '${source}';\n\nexport {};\n`,
    );
    expect(rules(messages)).toContain('import/no-restricted-paths');
  });

  it.each([
    ['src/domain/example.ts', '..'],
    ['src/domain/example.ts', '../index'],
    ['src/application/example.ts', '..'],
    ['src/application/example.ts', '../index'],
  ])('%s rejects an import of %s (the entry point)', async (file, source) => {
    const messages = await lint(
      file,
      `import {} from '${source}';\n\nexport {};\n`,
    );
    expect(rules(messages)).toContain('import/no-restricted-paths');
  });

  describe.each([
    ['src/domain/example.ts'],
    ['src/domain/example.test.ts'],
    ['src/application/example.ts'],
    ['src/application/example.test.ts'],
  ])('%s', file => {
    it.each([
      ['@backstage/errors'],
      ['@backstage/backend-plugin-api'],
      ['@backstage/backend-plugin-api/alpha'],
      ['express'],
      ['express/lib/router'],
      ['knex'],
    ])('rejects an import of %s', async source => {
      const messages = await lint(file, `import {} from '${source}';\n`);
      expect(rules(messages)).toContain('no-restricted-imports');
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
    ])('rejects an import of the Node.js module %s', async source => {
      const messages = await lint(file, `import {} from '${source}';\n`);
      expect(rules(messages)).toContain('no-restricted-imports');
    });
  });

  it.each([['src/domain/example.ts'], ['src/application/example.ts']])(
    '%s does not use fetch',
    async file => {
      const messages = await lint(
        file,
        "export const f = () => fetch('https://example.com');\n",
      );
      expect(rules(messages)).toContain('no-restricted-globals');
    },
  );

  it.each([
    ['src/adapters/backstage/example.ts'],
    ['src/adapters/persistence/example.ts'],
    ['src/plugin.ts'],
  ])(
    '%s may import Backstage, express, knex and Node.js modules',
    async file => {
      expect(
        await lint(
          file,
          "import {} from '@backstage/errors';\nimport {} from 'knex';\nimport {} from 'node:crypto';\n\nexport {};\n",
        ),
      ).toEqual([]);
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
  ])('rejects %s', async (_name, code, text) => {
    const messages = await lint('src/domain/example.ts', code);
    expect(messages.map(m => m.message).join('\n')).toContain(text);
  });

  it('accepts plain synchronous code', async () => {
    expect(
      await lint(
        'src/domain/example.ts',
        'export const double = (n: number): number => n * 2;\n',
      ),
    ).toEqual([]);
  });

  it('lets the application circle use async code and Promise', async () => {
    expect(
      await lint(
        'src/application/example.ts',
        'export const f = async (): Promise<number> => {\n  await Promise.resolve();\n  return 1;\n};\n',
      ),
    ).toEqual([]);
  });
});

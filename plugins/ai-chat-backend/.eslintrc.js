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

// The dependency rules of the host (architecture: "Keeping the direction with
// lint"). They apply to the circles that exist as folders:
//
// 1. `import/no-restricted-paths` is an allow list. `src/domain` imports only
//    `src/domain`; `src/application` imports only `src/domain` and
//    `src/application`. Anything else under `src`, including `src/index.ts`
//    (what `'..'` resolves to), is refused. The two adapters of the web side
//    do not import each other: `adapters/http` and `adapters/persistence`.
// 2. `domain/` and `application/` import no `@backstage/*` package, no
//    `express` or `knex`, and no Node.js built-in module (`fs`, `crypto`,
//    `node:*` and so on), and do not use `fetch`. The ports are how they
//    reach the outside.
// 3. `domain/` also has no `async` function, no `await` and no `Promise`.
//
// `src/lintRules.test.ts` lints sample files against this configuration.

const { builtinModules } = require('module');

const baseRestrictedPatterns = [
  // The patterns of the shared Backstage configuration, which the override
  // below replaces for these folders.
  '*.stories*',
  '*.test*',
  '**/__testUtils__/**',
  '**/__mocks__/**',
];

const noBackstage = '@backstage/*';
const noFrameworkPaths = ['express', 'knex'];
const noFrameworkPatterns = ['express/*', 'knex/*'];
// Every Node.js built-in module, with and without the `node:` prefix.
const noNodePaths = builtinModules;
const noNodePatterns = ['node:*', ...builtinModules.map(name => `${name}/*`)];

const restrictedImports = {
  paths: [...noFrameworkPaths, ...noNodePaths],
  patterns: [
    ...baseRestrictedPatterns,
    noBackstage,
    ...noFrameworkPatterns,
    ...noNodePatterns,
  ],
};

module.exports = require('@backstage/cli/config/eslint-factory')(__dirname, {
  settings: {
    // `import/no-restricted-paths` resolves each import to a file. Without
    // the TypeScript extensions an import without an extension does not
    // resolve, and the rule sees nothing.
    'import/resolver': {
      node: { extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] },
    },
  },
  rules: {
    'import/no-restricted-paths': [
      'error',
      {
        // Relative to the package, whatever the working directory is.
        basePath: __dirname,
        zones: [
          {
            target: './src/domain',
            from: './src',
            except: ['./domain'],
            message: 'domain imports only domain (inner circle only)',
          },
          {
            target: './src/application',
            from: './src',
            except: ['./domain', './application'],
            message: 'application imports only domain and application',
          },
          {
            target: './src/adapters/http',
            from: './src/adapters/persistence',
            message: 'the http adapter does not import the persistence adapter',
          },
          {
            target: './src/adapters/persistence',
            from: './src/adapters/http',
            message: 'the persistence adapter does not import the http adapter',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['src/domain/**', 'src/application/**'],
      rules: {
        'no-restricted-imports': ['error', restrictedImports],
        'no-restricted-globals': [
          'error',
          { name: 'fetch', message: 'Use a port instead of fetch.' },
        ],
      },
    },
    {
      // Pure code: no I/O and nothing asynchronous.
      files: ['src/domain/**'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: ':function[async=true]',
            message: 'The domain circle has no async function.',
          },
          {
            selector: 'AwaitExpression',
            message: 'The domain circle has no await.',
          },
          {
            selector: "Identifier[name='Promise']",
            message: 'The domain circle has no Promise.',
          },
        ],
      },
    },
  ],
});

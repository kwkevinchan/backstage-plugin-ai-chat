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

// The dependency rules of the core (architecture: "Keeping the direction with
// lint"). Three layers of checks:
//
// 1. The whole package never imports `@backstage/*`, tests included. The
//    manifest has no such runtime dependency either, and
//    `@backstage/no-undeclared-imports` rejects an import it does not list.
// 2. `import/no-restricted-paths` keeps the circles in order: domain imports
//    neither the application circle nor the testing entry point, and the
//    application circle does not import the testing entry point.
// 3. `domain/` and `application/` also never import `express` or `knex`, and
//    do not use `fetch`.
// 4. `domain/` has no `async` function, no `await`, no `Promise`, and imports
//    no Node.js module that does I/O.
//
// `src/lintRules.test.ts` lints sample files against this configuration.

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
const noIoPaths = ['fs', 'http', 'https', 'net', 'os', 'child_process'];
const noFrameworkPatterns = ['express/*', 'knex/*'];

module.exports = require('@backstage/cli/config/eslint-factory')(__dirname, {
  restrictedImportPatterns: [noBackstage],
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
            from: './src/application',
            message: 'domain must not import application (inner circle only)',
          },
          {
            target: './src/domain',
            from: './src/testing',
            message: 'domain must not import the testing entry point',
          },
          {
            target: './src/application',
            from: './src/testing',
            message: 'application must not import the testing entry point',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Test files get their own restricted imports from the shared
      // configuration, which has no patterns.
      files: ['**/*.test.*', '**/__testUtils__/**', '**/__mocks__/**'],
      rules: {
        'no-restricted-imports': ['error', { patterns: [noBackstage] }],
      },
    },
    {
      files: ['src/domain/**', 'src/application/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: noFrameworkPaths,
            patterns: [
              ...baseRestrictedPatterns,
              noBackstage,
              ...noFrameworkPatterns,
            ],
          },
        ],
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
        'no-restricted-imports': [
          'error',
          {
            paths: [...noFrameworkPaths, ...noIoPaths],
            patterns: [
              ...baseRestrictedPatterns,
              noBackstage,
              ...noFrameworkPatterns,
              'node:*',
            ],
          },
        ],
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

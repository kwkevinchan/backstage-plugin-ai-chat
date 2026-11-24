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
// 2. `import/no-restricted-paths` is an allow list. `domain` imports only
//    `domain`; `application` imports only `domain` and `application`. Anything
//    else under `src`, including `src/index.ts` (what `'..'` resolves to) and
//    `src/testing`, is refused. Test files may also import `src/testing`.
// 3. `domain/` and `application/` also never import `express` or `knex`, and
//    do not use `fetch`.
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
const noFrameworkPatterns = ['express/*', 'knex/*'];

// The test files of the shared configuration (@backstage/cli, eslint-factory).
const testFiles = [
  '**/*.test.*',
  '**/*.stories.*',
  '**/__testUtils__/**',
  '**/__mocks__/**',
  'src/setupTests.*',
  '!src/**',
];

const pathsRule = (allowedForTests = false) => [
  'error',
  {
    // Relative to the package, whatever the working directory is.
    basePath: __dirname,
    zones: [
      {
        target: './src/domain',
        from: './src',
        except: allowedForTests ? ['./domain', './testing'] : ['./domain'],
        message: 'domain imports only domain (inner circle only)',
      },
      {
        target: './src/application',
        from: './src',
        except: allowedForTests
          ? ['./domain', './application', './testing']
          : ['./domain', './application'],
        message: 'application imports only domain and application',
      },
    ],
  },
];

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
    'import/no-restricted-paths': pathsRule(),
  },
  overrides: [
    {
      // Test files get their own restricted imports from the shared
      // configuration, which has no patterns. They may use `src/testing`.
      files: testFiles,
      rules: {
        'import/no-restricted-paths': pathsRule(true),
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
  ],
});

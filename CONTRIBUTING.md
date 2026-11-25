# Contributing

Thanks for your interest. The project is pre-alpha, so please open an issue to
discuss larger changes before sending a pull request.

## Workflow

1. Fork the repository and create a branch from `main`.
2. `corepack enable && yarn install` (this also installs the git hooks).
3. Make your change, with tests where it makes sense.
4. Run the checks locally:

   ```sh
   yarn tsc && yarn lint:all && yarn test && yarn build:all
   yarn constraints && yarn boundaries
   yarn prettier:check && yarn lint:openapi && yarn build:api-reports
   ```

5. If a published package (`plugins/*`) changes, add a changeset with
   `yarn changeset` and describe the change for users.
6. Open a pull request against `main`.

## Try your change

```sh
yarn start:fake-llm   # scripted model server on port 4010, needs no key
yarn start            # legacy frontend system + backend; `yarn start:next` for the new one
```

`packages/backend` also has a development-only plugin (`dev-actions`) with one
read-only action and two that change something, so that the approval can be
tried without another action source.

The smoke test drives a real browser against the development apps and the
scripted model (`yarn test:e2e`, `yarn test:e2e:next`); it needs
`yarn playwright install chromium` once. It writes a screenshot of each step to
`e2e-test-results/<app>`.

The tests of the backend plugin run on SQLite. To run them on PostgreSQL 16
as CI does, start a server and set the connection string:

```sh
docker run -d --name ai-chat-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:16
BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING=postgresql://postgres:postgres@127.0.0.1:55432 \
  CI=true yarn workspace @kwkevinchan/backstage-plugin-ai-chat-backend test
```

## Layout

| Package                          | Role                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ai-chat-backend`                | Backend plugin `ai-chat`; depends on `ai-chat-harness`, `ai-chat-common` and `ai-chat-node`         |
| `ai-chat-node`                   | Extension point for backend modules; depends only on `ai-chat-harness`                              |
| `ai-chat-backend-module-example` | Private example module, not published; depends only on `ai-chat-node` and the Backstage backend API |
| `ai-chat`                        | Frontend plugin; depends on `ai-chat-common` and `ai-chat-react`                                    |
| `ai-chat-react`                  | Web library other frontend plugins use to open the chat; may depend on `ai-chat-common` only        |
| `app`, `app-next`                | Development apps (legacy and new frontend system); private                                          |
| `backend`                        | Development backend; private                                                                        |
| `ai-chat-harness` (`packages/`)  | Core of the agent loop; published, depends on no `@backstage/*` package                             |
| `ai-chat-common`                 | Types shared by the frontend and the backend; published                                             |

`yarn constraints` (`yarn.config.cjs`) checks the directions: frontend
packages never depend on backend packages or Node-only packages, and the other
way round, and a published package never on a private one. The backend
depends on the harness, the common types and `ai-chat-node`. `ai-chat-node`
depends only on the harness. A backend module of this plugin depends only on
`ai-chat-node`, not on the host or the harness. The frontend plugin
depends on `ai-chat-common` and `ai-chat-react`. `ai-chat-react` may depend on
`ai-chat-common` and on nothing else here. Another frontend package depends only on `ai-chat-react`,
not on the host plugin. The core
(`packages/ai-chat-harness`) depends on no other package of this repository
and lists no `@backstage/*` package as a runtime
dependency, and its lint rules (`packages/ai-chat-harness/.eslintrc.js`, tested in
`src/lintRules.test.ts`) keep `domain/` from importing `application/`, and
keep both circles from running code, reaching the file system or opening a
network: no import of `fs`, `child_process`, `vm`, `worker_threads`,
`cluster`, `module`, `net`, `http`, `https` or `dgram`, no `eval` or
`new Function`, and none of the other ways to get a module (`require`,
`process`, `globalThis`, dynamic `import()`; test files may use the globals of
the test runner).
The backend has the same rules for its `domain/` and `application/` folders
(`plugins/ai-chat-backend/.eslintrc.js`, tested in `src/lintRules.test.ts`):
they import no `@backstage/*`, `express`, `knex` or Node.js module, and
`domain/` imports nothing but `domain/`. `adapters/http` and
`adapters/persistence` do not import each other.

### Backend (`plugins/ai-chat-backend/src`)

| Folder / file           | Holds                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`               | Sessions, runs, principals and pure rules of the host; no I/O, no `async`                                                                                         |
| `application/`          | The use cases, `RunSupervisor` and the ports of the host (`application/ports/`)                                                                                   |
| `host.ts`               | `createHost()`: wires the loop, the supervisor and the use cases on the ports                                                                                     |
| `adapters/http/`        | The router, the controllers, `presenters/uiMessageStream.ts` (the only place that knows the stream protocol), `sse.ts`, the request schemas and `errorMapping.ts` |
| `adapters/persistence/` | `Knex*` implementations of the ports, on the tables of `migrations/`                                                                                              |
| `adapters/backstage/`   | Tools (Actions Registry), agent catalog (configuration and extension registrations), auditor, `principalFromRequest`                                              |
| `adapters/model/`       | The `ModelClient` of the core on an OpenAI-compatible server                                                                                                      |
| `adapters/system/`      | The clock and the UUID generator                                                                                                                                  |
| `migrations/`           | Knex migrations (a folder of the package, not of `src`)                                                                                                           |

The tests that matter most for the security rules are in
`integration/http.test.ts` (every route: status codes, the content of the
streams read back with the parser of the AI SDK, nothing of the system prompt
or of an error of the model server in a response, a user reads only their own
sessions) and `integration/hostFlows.test.ts` (approval runs the stored input,
once, from the owner only; nothing that is not read-only runs without
approval). `integration/twoBackends.test.ts` runs two backends on one
database: a decision that the other backend receives, a shutdown that ends
only its own runs, a backend that stops without a shutdown. The table of the
requirements of P1 and their tests is in
`docs/design/p1-coverage.zh-TW.md`.

## Shared definitions

`plugins/ai-chat-common` (`@kwkevinchan/backstage-plugin-ai-chat-common`) has
the types of the API and of the response stream, the paths of the routes and
the id of the assistant message of a run. The backend and the frontend import it. Backstage does not let a frontend
plugin import a backend plugin, so anything both sides need goes there.

## HTTP API spec

`plugins/ai-chat-backend/src/schema/openapi.yaml` describes every route.
`yarn lint:openapi` lints and validates it, and `src/schema/openapi.test.ts`
compares it with the routes of the router. Change it together with the routes
and the types in `plugins/ai-chat-common`.

## Releasing

Releases are cut by the maintainer from `main`, with
[changesets](https://github.com/changesets/changesets). The first release takes
both published packages from `0.0.0` to `0.1.0`.

1. `yarn changeset version`, then `yarn install` (not `--immutable`: the
   workspace versions are in `yarn.lock`). Review and commit both in a pull
   request.
2. On the merged `main`: `yarn install --immutable`, then
   `yarn tsc:full && yarn lint:all && yarn test && yarn build:all`.
3. `yarn workspace <package> pack --dry-run` lists what a package contains
   (`dist/`, `README.md`, `LICENSE`, `config.d.ts` and `migrations/` for the
   backend). Check the `package.json` in the tarball: `main`/`types` point at
   `dist/`.
4. Publish with Yarn, which replaces the `workspace:` ranges:
   `yarn workspaces foreach --all --no-private --topological npm publish --access public`,
   then `yarn changeset tag` and `git push --follow-tags`.

## Git hooks and boundary checks

The `pre-commit` hook runs `scripts/check-boundaries.mjs` on the staged changes,
plus [gitleaks](https://github.com/gitleaks/gitleaks) when it is installed. The
`commit-msg` hook checks the commit message. CI runs the same checks on every
pull request.

The boundary check rejects local file system paths, private keys, access tokens
and private package registries. You can add your own terms, one per line, in
`~/.config/boundary/denylist.txt` or the `BOUNDARY_DENYLIST` environment
variable. Never commit that list.

Please commit with your GitHub noreply email address.

## License

By contributing you agree that your contributions are licensed under the
[Apache License, Version 2.0](LICENSE).

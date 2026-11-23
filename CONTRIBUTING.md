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
   yarn constraints && yarn boundaries && yarn sync:common:check
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

| Package           | Role                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `ai-chat-backend` | Backend plugin `ai-chat`; depends on no other package of this repository |
| `ai-chat`         | Frontend plugin; depends on no other package of this repository          |
| `app`, `app-next` | Development apps (legacy and new frontend system); private               |
| `backend`         | Development backend; private                                             |

`yarn constraints` (`yarn.config.cjs`) checks the directions: frontend
packages never depend on backend packages or Node-only packages, and the other
way round, and a published package never on a private one.

### Backend (`plugins/ai-chat-backend/src`)

| Folder / file           | Holds                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `routes/`               | Express routes: authenticate the user, validate the request, stream the events (`sse.ts`) |
| `chat/ChatService.ts`   | The loop and the approval. The only place that invokes an action (`invokeAndStore`)       |
| `chat/ToolCatalog.ts`   | The actions offered to the model: filters and safe tool names                             |
| `database/ChatStore.ts` | The queries; the conditional updates that make a decision count once                      |
| `llm/`                  | The client of the OpenAI-compatible server                                                |
| `common/`               | Types and paths shared with the frontend                                                  |
| `migrations/`           | Knex migrations (a folder of the package, not of `src`)                                   |

The tests that matter most for the security rules are in
`chat/ChatService.test.ts` (approval runs the stored input, once, from the
owner only; nothing that is not read-only runs without approval).

## Shared definitions

`plugins/ai-chat-backend/src/common` (exported as
`@kwkevinchan/backstage-plugin-ai-chat-backend/common`) has the types of the
API and of the response stream. Backstage does not let a frontend plugin
import a backend plugin, so the frontend package has a copy in
`plugins/ai-chat/src/common`. Edit the backend files and run
`yarn sync:common`; the `pre-commit` hook and CI fail when the copy is out of
date.

## HTTP API spec

`plugins/ai-chat-backend/src/schema/openapi.yaml` describes every route.
`yarn lint:openapi` lints and validates it, and `src/schema/openapi.test.ts`
compares it with the routes of the router. Change it together with the routes
and the types in `src/common`.

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

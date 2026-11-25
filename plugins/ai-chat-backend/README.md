# @kwkevinchan/backstage-plugin-ai-chat-backend

Backend plugin (`ai-chat`) of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).
The model calls the actions of the actions registry as the signed-in user; an
action that is not read-only waits for the approval of the user.

```sh
yarn --cwd packages/backend add @kwkevinchan/backstage-plugin-ai-chat-backend
```

```ts
backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
```

The plugin keeps its state in its own database (tables `sessions`, `runs` and
`items`), so you can run more than one backend. It lists the actions through the
actions service of Backstage (`@alpha`), so add the plugins whose actions the
chat should offer to `backend.actions.pluginSources`. The settings (`llm`,
`toolsets`, `policy`, `agents`, the limits of a run and the context budget),
the approval model, the security notes and the HTTP API are in the
[README of the repository](https://github.com/kwkevinchan/backstage-plugin-ai-chat#readme).
A backend module registers further agents through
`@kwkevinchan/backstage-plugin-ai-chat-node`.
`plugins/ai-chat-backend-module-example` in this repository is a private
example of such a module, to copy from.
The routes are described in `src/schema/openapi.yaml`; the shared types and
paths are in `@kwkevinchan/backstage-plugin-ai-chat-common`.

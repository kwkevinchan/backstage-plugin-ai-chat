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

The configuration, the approval model, the security notes and the HTTP API are
in the [README of the repository](https://github.com/kwkevinchan/backstage-plugin-ai-chat#readme).
`/common` (`@kwkevinchan/backstage-plugin-ai-chat-backend/common`) has the
types of the API and of the response stream.

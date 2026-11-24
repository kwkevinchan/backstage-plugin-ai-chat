# @kwkevinchan/backstage-plugin-ai-chat-backend-module-example

Example backend module of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).

It registers one agent, `guide`, and one context provider, `site`. The text
of both mentions `example.com`. It imports only
`@kwkevinchan/backstage-plugin-ai-chat-node` and
`@backstage/backend-plugin-api`.

```sh
yarn --cwd packages/backend add @kwkevinchan/backstage-plugin-ai-chat-backend-module-example
```

```ts
backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
backend.add(
  import('@kwkevinchan/backstage-plugin-ai-chat-backend-module-example'),
);
```

A session can then use `agentId: guide`. The context provider is recorded and
is not added to the model input yet. If `aiChat.agents` also defines `guide`,
the backend does not start.

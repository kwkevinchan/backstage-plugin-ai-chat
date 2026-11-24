# @kwkevinchan/backstage-plugin-ai-chat

Frontend plugin of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat):
the chat page with streaming answers, tool calls and an approval card for every
action that is not read-only. It needs
[`@kwkevinchan/backstage-plugin-ai-chat-backend`](https://www.npmjs.com/package/@kwkevinchan/backstage-plugin-ai-chat-backend).

```sh
yarn --cwd packages/app add @kwkevinchan/backstage-plugin-ai-chat
```

Each session has its own URL, `/ai-chat/<session id>`. `/ai-chat?entityRef=component:default/my-service`
opens the chat for an entity: every message carries the entity to the backend.

- New frontend system: `import aiChatPlugin from '@kwkevinchan/backstage-plugin-ai-chat/alpha'`;
  the page is on `/ai-chat`.
- Legacy frontend system: `AiChatPage` and `aiChatPlugin` from the package;
  mount the page with `path="/ai-chat/*"` (`FlatRoutes` adds the `/*`).

More in the [README of the repository](https://github.com/kwkevinchan/backstage-plugin-ai-chat#readme).

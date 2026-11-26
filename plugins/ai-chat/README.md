# @kwkevinchan/backstage-plugin-ai-chat

Frontend plugin of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat):
the chat page with streaming answers, tool calls and an approval card (Allow
and Deny) for every action that is not read-only. A list of toolsets above the
message box switches the toolsets of the session on and off. It needs
[`@kwkevinchan/backstage-plugin-ai-chat-backend`](https://www.npmjs.com/package/@kwkevinchan/backstage-plugin-ai-chat-backend).

```sh
yarn --cwd packages/app add @kwkevinchan/backstage-plugin-ai-chat
```

Each session has its own URL, `/ai-chat/<session id>`. `/ai-chat?entityRef=component:default/my-service`
opens the chat for an entity: every message carries the entity to the backend.

- New frontend system: `import aiChatPlugin from '@kwkevinchan/backstage-plugin-ai-chat/alpha'`;
  the page is on `/ai-chat`, and the plugin registers `aiChatPanelApiRef` and
  mounts the side panel at the app root.
- Legacy frontend system: `AiChatPage` and `aiChatPlugin` from the package;
  `aiChatPlugin` registers `aiChatPanelApiRef`, and the page mounts with
  `path="/ai-chat/*"` (`FlatRoutes` adds the `/*`). Render `AiChatPanel` once
  inside the router and outside the routes. The panel keeps the open
  conversation when the page changes and stays hidden until sign-in completes.

Another plugin opens that panel with `AiChatLauncher`, `useAiChatPanel`, or
`aiChatPanelApiRef` from `@kwkevinchan/backstage-plugin-ai-chat-react`. A
prompt starts a new conversation and is sent at once. An entity reference is
sent with the messages.

A plugin shows the result of an action with its own component through
`aiChatToolResultsApiRef`: on the new frontend system with
`AiChatToolResultBlueprint` (`@kwkevinchan/backstage-plugin-ai-chat-react/alpha`),
on the legacy frontend system by replacing that API with
`createAiChatToolResultsApi([...])` from this package. The approval card stays.
See the README of `@kwkevinchan/backstage-plugin-ai-chat-react`.

More in the [README of the repository](https://github.com/kwkevinchan/backstage-plugin-ai-chat#readme).

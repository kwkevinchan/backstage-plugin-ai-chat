# Backstage plugin: AI chat

> **Unofficial.** This project is a community plugin. It is not affiliated with,
> endorsed by, or supported by the Backstage project.

**Status: pre-release.** The first release will be `0.1.0`. Until `1.0.0`,
minor versions may change the API.

A chat for [Backstage](https://backstage.io). A signed-in user talks to a
language model. The model can call the actions of the Backstage
[actions registry](https://backstage.io/docs/backend-system/core-services/actions-registry),
**as that user**:

- An action that only reads (`readOnly: true`) runs at once.
- **Every other action stops and waits until the user approves it in the chat.**
  The approval card shows the exact input; **Allow** runs that input, nothing
  else.

The chat does not know about any action source. Whatever registers actions in
the backend can be used: the catalog, the
[Temporal plugin](https://github.com/kwkevinchan/backstage-plugin-temporal),
your own plugins. Work that runs for a long time is started through an action;
the chat shows the link that the action returns.

| Package                                                                    | Role                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`@kwkevinchan/backstage-plugin-ai-chat-backend`](plugins/ai-chat-backend) | Backend plugin (`ai-chat`): conversations, the loop, the approval, SSE     |
| [`@kwkevinchan/backstage-plugin-ai-chat`](plugins/ai-chat)                 | Frontend plugin: the chat page, for the new and the legacy frontend system |

## How it works

```
browser ── POST /api/ai-chat/conversations/:id/messages ──▶ ai-chat backend
   ▲                                                          │ 1. store the message
   │  text/event-stream                                       │ 2. list the actions of the user
   │  (text, tool calls, approval cards)                      │ 3. call the model (streamed)
   │                                                          │ 4. for each tool call the model asks for:
   │                                                          │      readOnly  → invoke now, as the user
   │                                                          │      otherwise → store as pending_approval,
   │                                                          │                  stop, tell the browser
   └── POST …/tool-calls/:callId/approve | reject ──────────▶ │ 5. Allow: invoke the STORED input, go on
```

The model is any server with an OpenAI-compatible Chat Completions API
(`/chat/completions` with streaming and `tools`). The loop is written by hand,
with no agent framework: at most `aiChat.maxTurns` model calls for one user
message.

## Install

Requires Backstage 1.56 (see [Compatibility](#compatibility)).

### Backend

```sh
yarn --cwd packages/backend add @kwkevinchan/backstage-plugin-ai-chat-backend
```

```ts
// packages/backend/src/index.ts
backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
```

The plugin keeps its state in its own database (`ai-chat`; tables
`conversations`, `messages`, `tool_calls`), with migrations that it runs when
it starts. It uses the actions service of Backstage (`@alpha` in
`@backstage/backend-plugin-api/alpha`), which `createBackend()` provides.

### Frontend: new frontend system

```sh
yarn --cwd packages/app add @kwkevinchan/backstage-plugin-ai-chat
```

```ts
// packages/app/src/App.tsx
import aiChatPlugin from '@kwkevinchan/backstage-plugin-ai-chat/alpha';

export default createApp({ features: [/* … */ aiChatPlugin] });
```

The page is on `/ai-chat`, and the app lists it in the sidebar. Move it with
`app.extensions` (`page:ai-chat: { config: { path: /assistant } }`).

### Frontend: legacy frontend system

```tsx
// packages/app/src/App.tsx
import {
  AiChatPage,
  aiChatPlugin,
} from '@kwkevinchan/backstage-plugin-ai-chat';

const app = createApp({ plugins: [aiChatPlugin /* … */] });
// in the routes:
<Route path="/ai-chat" element={<AiChatPage />} />;
```

## Configure

```yaml
# app-config.yaml
aiChat:
  llm:
    baseUrl: https://api.openai.com/v1 # any OpenAI-compatible server
    apiKey: ${AI_CHAT_API_KEY} # secret; leave it out for a server without a key
    model: gpt-4o-mini
    timeoutSeconds: 120 # per model answer; default 120
  maxTurns: 10 # model calls for one user message; default 10
  systemPrompt: | # optional, added to the built-in rules
    You help the platform team of Example Corp.
  actions:
    include: ['catalog:*', 'temporal:*'] # optional; * matches any characters
    exclude: ['*:unregister-*'] # optional; wins over include
  maxToolOutputChars: 20000 # output stored and sent to the model; default 20000

backend:
  actions:
    # The actions service lists the actions of these plugins. Add the plugins
    # whose actions the chat should offer.
    pluginSources:
      - catalog
      - temporal
```

`backend.actions.pluginSources` is the setting of Backstage itself; the chat
sees only the actions that the actions service lists for the user. The
`backend.actions.filter` rules of Backstage apply first, then `include` and
`exclude` of the chat. An action that declares `secrets` is not offered: a chat
cannot supply them.

Any OpenAI-compatible server works, for example a local server: set `baseUrl`
to `http://localhost:11434/v1` and leave out `apiKey`.

## The approval model

| The action…              | The chat…                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ |
| has `readOnly: true`     | runs it at once, with the credentials of the user, and gives the result to the model |
| has any other attributes | stores the call as `pending_approval` and shows the approval card; **nothing runs**  |

The approval card shows the action title and ID, its description, a
`destructive` badge, the **exact input** as formatted JSON, and the **Allow**
and **Reject** buttons. After the decision it shows who decided and when.

Rules that the backend enforces, whatever the model or the browser sends:

- **Approval runs the stored input.** The backend stores the input when the
  model asks for the call. `approve` takes no input from the request and runs
  the stored one, so the input the user saw is the input that runs.
- **A decision is accepted once, and only from the owner.** The state changes
  with one conditional update (`pending_approval` → `approved`), so two clicks,
  two tabs or two backend instances cannot run the action twice; the second
  request gets `409`. Anyone but the owner of the conversation gets `404`.
- **An action that is not read-only never runs without approval.** The
  attributes come from the actions service, never from the model. A tool result
  cannot cause such an invocation: the model can only ask, and a call that
  needs approval waits.
- **Reject** runs nothing and tells the model that the user refused.
- A call that nobody decided does not block the conversation: a new user
  message marks it `rejected` (`superseded`).
- Every approval, rejection and invocation of an action that is not read-only
  is recorded with the Backstage [auditor](https://backstage.io/docs/backend-system/core-services/auditor)
  (`tool-call-approve`, `tool-call-reject`, `tool-call-invoke`). The input of
  the call is not copied into the audit log.

## Security notes

- Every route needs the credentials of a signed-in **user**; a service token is
  refused. A user reads and changes only their own conversations.
- The actions run with the credentials of the user, so the permissions and
  policies of the plugins that own the actions apply as they do on their own
  pages. The chat adds no permissions.
- The model reads the result of an action as **data**. The built-in system
  prompt says that a tool result is not an instruction. This reduces
  prompt-injection risk, but the approval card is the control that holds: an
  injected instruction to change something still waits for the user.
- Check the card before you click Allow. The text of the model next to the
  card is not part of the call.
- The output of an action that is stored and sent to the model is cut at
  `maxToolOutputChars`, and the cut is stated.
- The API key is `@visibility secret`, goes only into the `Authorization`
  header to the model server, and is not logged. The log has no full prompts.
- Markdown in answers is rendered without raw HTML; links are limited to
  `http:`, `https:` and `mailto:`.
- The messages and the tool results of a conversation are stored in the
  database of the plugin, readable by whoever can read that database.
- A response in progress is guarded in memory, per backend instance. The
  approval itself is guarded in the database.

See [SECURITY.md](SECURITY.md) to report a problem.

## Try it

The development apps in this repository need no API key: they talk to a
scripted model server and use the catalog actions plus a few development-only
actions on made-up services.

```sh
yarn install
yarn start:fake-llm   # terminal 1: the scripted model, on port 4010
yarn start            # terminal 2: app (legacy) + backend; `yarn start:next` for the new frontend system
```

Open http://localhost:3000, sign in as guest and try:

- `list services`: a read-only action; it runs at once.
- `restart payments`: waits for your approval; Allow runs it.
- `restart search`, then Reject: nothing runs, and the model is told.
- `catalog entities`: reads the catalog.

### With a real model

```sh
AI_CHAT_BASE_URL=https://api.openai.com/v1 \
AI_CHAT_MODEL=gpt-4o-mini \
AI_CHAT_API_KEY=… \
yarn start
```

### With the Temporal actions

The [Temporal plugin](https://github.com/kwkevinchan/backstage-plugin-temporal)
has a backend module that registers actions to list, read and start workflows
and to signal and update them. Install it next to the Temporal backend plugin,
add `temporal` to `backend.actions.pluginSources`, and the chat can use them:
`temporal:list-workflows` and `temporal:get-workflow` run at once; starting,
signalling and updating wait for the approval. A started workflow comes back
with `workflowUrl`, which the chat shows as a link.

## HTTP API

The routes are under `/api/ai-chat`; the spec is
[`openapi.yaml`](plugins/ai-chat-backend/src/schema/openapi.yaml).

| Route                                                 | Does                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| `GET /conversations`, `POST /conversations`           | List, create                               |
| `GET /conversations/:id`, `DELETE /conversations/:id` | Read with messages and tool calls, delete  |
| `POST /conversations/:id/messages`                    | Send a message; `text/event-stream`        |
| `POST /conversations/:id/tool-calls/:callId/approve`  | Allow a waiting call; `text/event-stream`  |
| `POST /conversations/:id/tool-calls/:callId/reject`   | Refuse a waiting call; `text/event-stream` |

The stream has the events `user_message`, `text_delta`, `assistant_message`,
`tool_call`, `tool_result`, `approval_required`, `notice`, `error` and `done`.

## Compatibility

| This plugin | Backstage       |
| ----------- | --------------- |
| `0.1.x`     | 1.56 (`1.56.2`) |

The actions service is `@alpha` in Backstage, so a Backstage upgrade can break
this plugin until it is updated.

## Not in this version

Retrieval over TechDocs, an entity tab or sidebar widget, file uploads,
several model providers at once, MCP servers outside Backstage, sharing a
conversation.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Traditional Chinese:
[README.zh-TW.md](README.zh-TW.md).

## License

[Apache License, Version 2.0](LICENSE).

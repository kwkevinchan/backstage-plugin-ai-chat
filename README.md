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
| [`@kwkevinchan/backstage-plugin-ai-chat-backend`](plugins/ai-chat-backend) | Backend plugin (`ai-chat`): sessions, the loop, the approval, SSE          |
| [`@kwkevinchan/backstage-plugin-ai-chat`](plugins/ai-chat)                 | Frontend plugin: the chat page, for the new and the legacy frontend system |

## How it works

```
browser ── POST /api/ai-chat/sessions/:id/runs ───▶ ai-chat backend
   ▲                                                 │ 1. start a run, store the message
   │  text/event-stream                              │ 2. list the actions of the user
   │  (AI SDK UI message stream: text, tool calls,   │ 3. call the model (streamed)
   │   approval requests)                            │ 4. for each tool call the model asks for:
   │                                                 │      readOnly  → invoke now, as the user
   │                                                 │      otherwise → store it, stop the run,
   │                                                 │                  ask for approval
   └── POST …/tool-calls/:callId/decision ─────────▶ │ 5. the decision is stored; the last one
                                                     │    carries the run on with the STORED input,
                                                     │    on whichever backend gets it
```

The model is any server with an OpenAI-compatible Chat Completions API
(`/chat/completions` with streaming and `tools`). The loop is written by hand,
with no agent framework. It lives in its own package without any dependency on
Backstage, [`@kwkevinchan/ai-chat-harness`](packages/ai-chat-harness); the
backend plugin connects it to the database, the actions service and HTTP.

A **run** is one user message and the approvals that follow it. It is stored
as an append-only log of items, so a closed tab does not lose the answer, and
it has limits: at most `aiChat.maxTurns` model calls, at most
`aiChat.maxToolCallsPerRun` tool calls, and at most `aiChat.runTimeoutSeconds`
of work (the time spent waiting for an approval does not count). A session has
one run at a time.

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
`sessions`, `runs`, `items`), with migrations that it runs when
it starts. On SQLite it allows one connection: the pool maximum must be 1,
which is what Knex uses for SQLite unless the configuration says otherwise.
A deployment that needs more than one connection uses PostgreSQL. It uses the
actions service of Backstage (`@alpha` in
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
`app.extensions` (`page:ai-chat: { config: { path: /assistant } }`). Each
session has its own URL, `/ai-chat/<session id>`. A link to
`/ai-chat?entityRef=component:default/my-service` opens the chat for that
entity: every message of it carries the entity (and the path of the page) to
the backend, which stores it with the message and tells the model in one line
before the text ("The user is on the page of "component:default/my-service"
("/ai-chat/…").").

To open the chat from an entity page, add a link there that names the entity,
for example in a card or a context menu of the entity page:

```tsx
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';

function AskAboutThis() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  return (
    <Link to={`/ai-chat?entityRef=${encodeURIComponent(entityRef)}`}>
      Ask the AI chat
    </Link>
  );
}
```

The side panel that opens the chat on every page (P2) will replace this link.

### Frontend: legacy frontend system

```tsx
// packages/app/src/App.tsx
import {
  AiChatPage,
  aiChatPlugin,
} from '@kwkevinchan/backstage-plugin-ai-chat';

const app = createApp({ plugins: [aiChatPlugin /* … */] });
// in the routes: the page needs the `/*`, because each session has its own
// URL (`/ai-chat/<session id>`); `FlatRoutes` adds it itself.
<Route path="/ai-chat/*" element={<AiChatPage />} />;
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
    images: false # the model reads images; default false. See "Images"
  systemPrompt: | # optional, added to the built-in rules
    You help the platform team of example.com.
  toolsets: # groups of actions; see "Toolsets and policy"
    catalog:
      title: Catalog
      actions: ['catalog:*'] # * matches any characters
      exclude: ['catalog:unregister-*'] # optional; not part of the toolset
      default: true # on in a new session; default false
    temporal:
      actions: ['temporal:*']
      default: true
    web:
      actions: ['web:*']
      egress: true # sends data out of the organization: always asks
  policy: # by complete action ID: allow, ask or deny
    'catalog:get-entity': allow
    'temporal:terminate-workflow': deny
  # Limits of one run (a message and the approvals after it)
  maxTurns: 10 # model calls; default 10
  maxToolCallsPerRun: 30 # tool calls the model may ask for; default 30
  runTimeoutSeconds: 300 # work time without the wait for approvals; default 300, at most 600
  # How much of a long session the model gets
  context:
    tokenBudget: 100000 # estimated tokens of the model input; default 100000
    keepRecentSteps: 6 # newest steps that are never shortened; default 6
  maxToolOutputChars: 20000 # output stored and sent to the model; default 20000, at least 100
  # What the user may add while a run goes on
  input:
    insert:
      maxPerRun: 5 # messages inserted into one run; default 5
    queue:
      maxMessages: 5 # queued messages in one session; default 5
    images: # needs llm.images: true
      maxPerMessage: 4 # images in one message; default 4
      maxBytes: 5242880 # largest image; default 5 MB
      maxBytesPerInput: 20971520 # image bytes in one run and in one model call; default 20 MB, at least maxPerMessage times maxBytes
      maxPendingPerSession: 12 # uploaded images that are in no message yet; default 12
      tokensPerImage: 1600 # what an image counts in the context budget; default 1600

backend:
  actions:
    # The actions service lists the actions of these plugins. Add the plugins
    # whose actions the chat should offer.
    pluginSources:
      - catalog
      - temporal
```

`aiChat.llm` is the only required block. The backend reads and checks the
whole `aiChat` section at startup, and a wrong value stops it.
`backend.actions.pluginSources` is the setting of Backstage itself; the chat
sees only the actions that the actions service lists for the user. The
`backend.actions.filter` rules of Backstage apply first, then the toolsets of
the chat. An action that declares `secrets` is not offered: a chat cannot
supply them.

**Images.** With `aiChat.llm.images: true`, a user can attach PNG, JPEG, WebP
or GIF images to a message. **The images are sent to the model server** as part
of the message, so they leave your organization when the server is outside it.
Leave `images` off (the default) when they must not. The backend stores the
images in its database, per session; only the owner of the session reads them,
and an image that no message uses is deleted after 24 hours.

| Setting                   | Meaning                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxTurns`                | Most model calls in one run.                                                                                                                                                                                                                                                                                                |
| `maxToolCallsPerRun`      | Most tool calls the model may ask for in one run. A call beyond the limit is answered with "tool call limit" and does not run.                                                                                                                                                                                              |
| `runTimeoutSeconds`       | Most seconds of work in one run, at most 600. The tools run with the token of the user, so a run also ends before that token expires (the shortest life that Backstage allows is 10 minutes).                                                                                                                               |
| `context.tokenBudget`     | Size of the model input in estimated tokens (one token is a quarter of an ASCII character or one other character). Set it well below the context window of the model.                                                                                                                                                       |
| `context.keepRecentSteps` | The newest steps that are never shortened or left out.                                                                                                                                                                                                                                                                      |
| `input.insert.maxPerRun`  | Most messages the user may insert into one run that is going on (at most 20). The model reads an inserted message in its next call, and a run that is about to end reads it first. A run that stops without reading it (a limit, an error, Stop) leaves it marked as not read.                                              |
| `input.queue.maxMessages` | Most messages in the queue of one session. A queued message waits for the run to end; when the run ends the normal way (the model answered, no limit stopped it) and the credentials of the user last for another run, the first message starts a new run. After any other end the queue waits until the user continues it. |
| `maxToolOutputChars`      | The output of an action is cut here, and the cut is stated.                                                                                                                                                                                                                                                                 |

When the input is over `tokenBudget`, the old outputs of tools are shortened
to one line first. If that is not enough, the old steps are replaced by a
summary that the model writes, and the page says that earlier content was left
out. The log itself never changes.

### Toolsets and policy

A session offers the actions of the toolsets that are switched on for it. A
new session starts with the toolsets that have `default: true`. The user
switches toolsets on and off in their own session (the **Toolsets** list at the top
of the chat, above the messages), only the ones that you define.

- An action in no toolset is never offered. Without `aiChat.toolsets`, one
  toolset with every action is on in every session.
- `policy` takes complete action IDs only; a key with `*` is refused. `deny`
  never runs an action and never offers it. `ask` asks every time. `allow`
  takes effect only for an action that has `readOnly: true` and is not in an
  `egress` toolset; any other action asks for approval, and the backend logs a
  warning when the policy sets such an action to `allow`. An action that is not
  listed runs at once when it only reads, and asks otherwise.
- An action without the `readOnly` attribute counts as not read-only.
- `egress: true` is for actions that send data out of the organization. They
  ask even when they only read.

`actions.include` and `actions.exclude` are deprecated. Without `toolsets`
they make the one default toolset, with `toolsets` they are ignored, and the
backend logs a warning when either is set. They will be removed in a later
version.

Any OpenAI-compatible server works, for example a local server: set `baseUrl`
to `http://localhost:11434/v1` and leave out `apiKey`.

## The approval model

| The action…                                                                            | The chat…                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| has `readOnly: true`, is not in an `egress` toolset, and the policy does not say `ask` | runs it at once, with the credentials of the user, and gives the result to the model    |
| is anything else                                                                       | stores the call, ends the run as waiting, and shows the approval card; **nothing runs** |
| is set to `deny` in the policy                                                         | never offers it, and answers a call of it with "denied"                                 |

The approval card shows the title of the action and its ID, its description,
why it asks (it changes something, or the policy of the administrator asks),
the **exact input** as formatted JSON, and the **Allow** and **Deny** buttons.
Invisible characters in the input are written as `\uXXXX`, with a warning.
After the decision the card shows who decided and when.

Rules that the backend enforces, whatever the model or the browser sends:

- **Approval runs the stored input.** The backend stores the input when the
  model asks for the call. The `decision` route takes no input from the
  request and the run uses the stored one, so the input the user saw is the
  input that runs. Before it runs, the input is checked again against the
  schema the action has now, and the policy is read again: an action that
  changed or that is now denied does not run.
- **A decision is accepted once, and only from the owner.** A unique index of
  the database allows one decision for a call, so two clicks, two tabs or two
  backends cannot run the action twice; the second request gets the first
  answer. Anyone but the owner of the session gets `404`.
- **An action that is not read-only never runs without approval.** The
  attributes come from the actions service, never from the model. A tool result
  cannot cause such an invocation: the model can only ask, and a call that
  needs approval waits.
- **Deny** runs nothing and tells the model that the user refused.
- Several calls in one step are decided one by one. Once every call is
  decided, the allowed ones run in the order the model asked for them.
- A run that waits for a decision holds the session: a new message gets `409`.
  **Stop** ends the waiting run, and its calls do not run.
- A call that is not read-only is recorded as started before it runs. If a
  backend stops while it runs, nobody runs it again: the card shows
  "Result unknown".
- Every approval, denial and invocation of an action that is not read-only
  is recorded with the Backstage [auditor](https://backstage.io/docs/backend-system/core-services/auditor)
  (`tool-call-approve`, `tool-call-deny`, `tool-call-invoke`). The input of
  the call is not copied into the audit log.

## Running several backends

The state of a run is in the database, not in the process, so you can run more
than one backend and restart them.

- A closed tab or a lost connection does not stop a run. It works to the end
  and stores the result; the page shows it when it is opened again.
- Each running run holds a lease in the database, which its backend renews
  every 10 seconds. A run that waits for an approval holds none, so the backend
  that receives the last decision carries it on, also a different one from the
  backend that started it. The action runs once.
- When a backend shuts down, it takes no new run, gives the running ones up to
  20 seconds, and marks the rest `expired`. It touches only its own runs.
- When a backend dies without a shutdown, another backend marks its runs
  `expired` once the lease has lapsed (30 seconds, checked every 30 seconds).
  The session is free for a new message then.
- The page shows an `expired` run as "The last run stopped before it gave an
  answer." with a button that sends the message again.

## Security notes

- Every route needs the credentials of a signed-in **user**; a service token is
  refused. A user reads and changes only their own sessions.
- The actions run with the credentials of the user, so the permissions and
  policies of the plugins that own the actions apply as they do on their own
  pages. The chat adds no permissions.
- The core of the loop can run no code, reach no file and open no network: its
  only way to act is a tool, which is an action of the actions service. The
  lint rules of the repository keep out the imports of `fs`, `child_process`,
  `vm`, `worker_threads`, `cluster`, `module`, `net`, `http`, `https` and
  `dgram`, `eval` and `new Function`, and the other ways to get a module
  (`require`, `process`, `globalThis`, dynamic `import()`). This is a static
  check of the source, not a sandbox.
- The model reads the result of an action as **data**. The built-in system
  prompt says that a tool result is not an instruction. This reduces
  prompt-injection risk, but the approval card is the control that holds: an
  injected instruction to change something still waits for the user.
- Check the card before you click Allow. The text of the model next to the
  card is not part of the call.
- The output of an action that is stored and sent to the model is cut at
  `maxToolOutputChars`, and the cut is stated. The user sees the same result
  that is stored.
- The system prompt is never in a response of the backend, and the page shows
  a fixed text when the model server fails, not what the server said.
- The API key is `@visibility secret`, goes only into the `Authorization`
  header to the model server, and is not logged. The log has no full prompts.
- The page sends the entity and the path of the page with each message. The
  backend checks both (an entity reference and a path), stores them with the
  message, and tells the model on one line before the text. It is not in the
  system prompt.
- Markdown in answers is rendered without raw HTML or images; links are limited
  to `http:`, `https:` and `mailto:`.
- The messages and the tool results of a session are stored in the database
  of the plugin, readable by whoever can read that database.

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
- `restart search`, then Deny: nothing runs, and the model is told.
- `restart both`: two calls in one step; decide each one, and reload between
  the two to see that the first decision stays.
- `slow restart payments`: an action that takes a few seconds; reload while it
  runs and the page follows it.
- `catalog entities`: reads the catalog.
- `where am I`: open the chat with `/ai-chat?entityRef=component:default/example-payments`
  first, and the model tells you the entity of the page.
- `story`: a long answer that streams word by word. Stop ends a run.

Open **Toolsets** at the top of the chat, above the messages, to switch a toolset off; its actions
are gone from the next step.

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

| Route                                            | Does                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /sessions`, `POST /sessions`                | List, create                                                                        |
| `GET /sessions/:id`                              | Read with the items, the run that has not ended, `awaitingDecision` and `resumable` |
| `PATCH /sessions/:id`, `DELETE /sessions/:id`    | Change title, pin, archive or toolsets; delete                                      |
| `POST /sessions/:id/runs`                        | Send a message and stream the run; `text/event-stream`                              |
| `POST /sessions/:id/runs/:runId/cancel`          | Ask a run to stop (`202`)                                                           |
| `POST /sessions/:id/tool-calls/:callId/decision` | Allow or deny a waiting call; JSON, or the stream when it was the last one          |
| `POST /sessions/:id/resume`                      | Carry on a run whose decisions are all stored (`204` if none)                       |
| `GET /sessions/:id/stream`                       | Join a run that is under way (`204` if none)                                        |
| `GET /toolsets`                                  | The toolsets the user can switch on in a session                                    |
| `GET /sessions/:id/tools`                        | The tools a session offers now: title, description, `readOnly` (the owner only)     |

The streams are the [AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
(`ai@7`): a call that needs approval is a `tool-approval-request`, and the
transient `data-run` part tells the state of the run before the stream ends.
A failed run ends with a fixed error text. The types are in
`@kwkevinchan/backstage-plugin-ai-chat-common`.

## Compatibility

| This plugin | Backstage       |
| ----------- | --------------- |
| `0.1.x`     | 1.56 (`1.56.2`) |

The actions service is `@alpha` in Backstage, so a Backstage upgrade can break
this plugin until it is updated.

## Not in this version

Retrieval over TechDocs, an entity tab or sidebar widget, file uploads,
several model providers at once, MCP servers outside Backstage, sharing a
conversation, agents of your own with skills and hooks, and the list of
sessions with search, pin, archive and automatic titles (until then every
session in the list is called "New conversation").

Limits of this version:

- A client that opens a session while a run is under way can follow it only on
  the backend that runs it. On another backend `GET /sessions/:id/stream`
  answers `204`, and the page shows what is stored so far.
- A summary covers the steps before the newest message of the user. Inside one
  run the old steps are shortened and then left out, never summarized.
- The model server may not report token use, so the size of the input is
  estimated from the characters.
- The page uses `ai@7` and the AI SDK UI message stream. The plugin is
  pre-release: minor versions may change the API.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Traditional Chinese:
[README.zh-TW.md](README.zh-TW.md).

## License

[Apache License, Version 2.0](LICENSE).

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
one run at a time. A session can be searched by title, pinned, renamed or
archived, and after its first round ends normally it gets a short title. A
title you set is kept.

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

`GET /sessions` includes `activity` (`running` or `waiting_approval`) while a
run has not ended. To push activity changes (`running`, `waiting_approval`,
`replied`, `idle`) to the session owner on the `ai-chat` Signals channel,
install `@backstage/plugin-signals-backend` the way this Backstage version
documents and add the module:

```ts
import { aiChatSignalsModule } from '@kwkevinchan/backstage-plugin-ai-chat-backend';

backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
backend.add(aiChatSignalsModule);
backend.add(import('@backstage/plugin-signals-backend'));
```

The plugin keeps its state in its own database (`ai-chat`; tables
`sessions`, `runs`, `items`), with migrations that it runs when
it starts. On SQLite it allows one connection: the pool maximum must be 1,
which is what Knex uses for SQLite unless the configuration says otherwise.
A deployment that needs more than one connection uses PostgreSQL. It uses the
actions service and the metrics service of Backstage (`actionsServiceRef` and
`metricsServiceRef`, `@alpha` in `@backstage/backend-plugin-api/alpha`), which
`createBackend()` provides. A backend that is not made with `createBackend()`
must install both (`actionsServiceFactory` and `metricsServiceFactory` of
`@backstage/backend-defaults/alpha`), or the plugin does not start.

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

A session can be bound to one entity. `POST /sessions` with an `entityRef`
binds the new session to it; otherwise the first message of a session binds it
to the entity of its page. The ref needs a kind, is stored in lower case
(`component:default/my-service`), and the user must be able to read the entity
in the catalog, with their own credentials. The binding never changes.
`GET /sessions?entityRef=component:default/my-service` lists the sessions of the
user bound to that entity.

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

Another plugin opens the same chat in a side panel through the
`aiChatPanelApiRef` Utility API, without linking to the page. The panel waits
until sign-in completes before rendering and stays mounted when the page
changes. A `prompt` starts a new conversation and is sent at once as the
signed-in user (pass fixed text or values your plugin controls, not URL query
parameters or other untrusted input). An `entityRef` is sent with the messages
of that conversation. `AiChatLauncher` accepts `className` and renders nothing
when the chat plugin is not installed in the app.

```tsx
import { AiChatLauncher } from '@kwkevinchan/backstage-plugin-ai-chat-react';

<AiChatLauncher
  prompt="where is this component?"
  entityRef="component:default/example.com"
>
  Ask about example.com
</AiChatLauncher>;
```

`useAiChatPanel()` from the same package reads `isOpen` and exposes `open()`
and `close()` through `aiChatPanelApiRef`. `open()` with no prompt and no
entity reference does not replace the conversation. `close()` hides the panel
and leaves the conversation mounted.

On the legacy frontend system, render `<AiChatPanel>` once inside the router
and outside the routes. The new frontend system mounts the same panel with
the plugin, so the app does not render it again.

### Frontend: legacy frontend system

```tsx
// packages/app/src/App.tsx
import {
  AiChatPage,
  AiChatPanel,
  aiChatPlugin,
} from '@kwkevinchan/backstage-plugin-ai-chat';

const app = createApp({ plugins: [aiChatPlugin /* … */] });
// in the routes: the page needs the `/*`, because each session has its own
// URL (`/ai-chat/<session id>`); `FlatRoutes` adds it itself.
<Route path="/ai-chat/*" element={<AiChatPage />} />;
// once, inside the router and outside the routes:
<AiChatPanel />;
```

### Result components of actions

A plugin can show the result of an action with its own component, for
example a table, under the row of the call. The chat keeps that row and the
approval card. On the new frontend system the plugin adds an extension of
`AiChatToolResultBlueprint` (`@kwkevinchan/backstage-plugin-ai-chat-react/alpha`);
on the legacy frontend system the app replaces `aiChatToolResultsApiRef` with
`createAiChatToolResultsApi([...])`. The output is untrusted data: a component
never uses `dangerouslySetInnerHTML` and links only `http:`, `https:` and
`mailto:` addresses (`AiChatSafeLink`). The details and the rules are in the
[README of `ai-chat-react`](plugins/ai-chat-react/README.md#result-components-of-actions).
The development apps show `dev-actions:list-services` as a table.

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
    parallelToolCalls: false # ask the server for parallel tool calls; default false
    requestsPerMinute: 60 # optional; calls per minute over all backends
    reportUsage: true # ask for the tokens of each answer (stream_options); default true
  models: # optional; more models that an agent names with `model`
    small:
      baseUrl: https://llm.example.com/v1
      apiKey: ${AI_CHAT_SMALL_API_KEY}
      model: some-small-model
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
  agents: # optional; without this block the only agent is default
    default:
      title: Backstage Agent
      toolsets: [catalog]
    sre:
      title: SRE Agent
      systemPrompt: You help the on-call engineer of example.com. Write a plan first, and cite the source.
      toolsets: [catalog, temporal]
      skills: [deploy-failure, rollback]
      model: default
      planning: required
      limits:
        maxSteps: 8
        maxToolCallsPerRun: 20
        runTimeoutSeconds: 300
  # Limits of one run (a message and the approvals after it)
  maxTurns: 10 # model calls; default 10
  maxToolCallsPerRun: 30 # tool calls the model may ask for; default 30
  runTimeoutSeconds: 300 # work time without the wait for approvals; default 300, at most 600
  maxToolCallsPerStep: 8 # tool calls in one answer of the model; default 8
  readConcurrency: 4 # read-only calls that run at the same time; default 4
  toolTimeoutSeconds: 60 # one tool call; default 60, at most 600
  runsPerUser: 3 # runs one user may have going on; default 3
  # How much of a long session the model gets
  context:
    tokenBudget: 100000 # estimated tokens of the model input; default 100000
    keepRecentSteps: 6 # newest steps that are never shortened; default 6
  maxToolOutputChars: 20000 # output stored and sent to the model, also of load_skill; default 20000, at least 100
  toolOutput: # optional; by action ID pattern (* matches any characters)
    '*':
      redact: [password, token] # field names hidden at any depth
    'catalog:get-entity':
      maxOutputChars: 4000 # lower than maxToolOutputChars for this action
  writesPerMinute: 20 # optional; changes one user may make per minute, over all backends
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
      tokensPerImage: 1600 # estimated tokens per image in the budget; default 1600
  sharing: # read at startup
    live:
      enabled: true # a share may keep updating; default true
      defaultHours: 24 # life of a live share when nobody picks one; default 24
      maxHours: 72 # longest life, in hours; default 72
  retention:
    days: 90 # delete a session this many days after its last change; 0 keeps every session; default 90

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

**Sharing limits.** `aiChat.sharing.live` is read at startup. `enabled`
(default true) is whether a share may keep updating. `defaultHours` (default 24) is how long a live share lasts when nobody picks a life, and `maxHours`
(default 72) is the longest life. Leave `sharing` or `live` out and these
defaults are used. With `enabled: false` the owner can still share a
snapshot, but not make a live share or give one a new life. Both hour values
must be positive integers, and `defaultHours` must not be greater than
`maxHours`; otherwise the backend does not start.

**Sharing.** The owner of a session shares it, read-only, with a user or a
group from the Share dialog or through the routes `/sessions/{id}/shares`. A
**snapshot** (the default) shows the session up to the moment of the share; the
owner refreshes it to move it on. A **live** share shows what comes next too,
until it expires, and then stays as it was at that moment. The sharee sees the
messages, the plan, the tools that were called with their input, the images of
the messages they see, and the tool output, unless the owner leaves it out; in a
live share the tool output written after the share is left out until the owner
shows it. A tool result that is left out keeps its status with the text "not
shared". **The sharee sees tool output that was read with the owner's
permissions**, and a group share is seen by whoever is in the group when they
open it. The sharee cannot send a message, decide an approval or change
anything: every such request answers like a session that does not exist. Anyone
who can read a session can copy it into their own session (`POST /sessions/{id}/fork`,
or "Copy to my sessions" in the read-only banner); copying brings the visible
messages, plans, and images in scope as new attachments, without tool calls or
tool outputs. Making, changing, cancelling and copying a share are written to
the auditor (`session-share`, `session-share-update`, `session-share-revoke`,
`session-fork`). A cancel stops every read at once.

**Images.** `aiChat.llm.images` is the global switch for image attachments:
when `true`, the UI shows the attach button (`GET /input-config`), the backend
accepts PNG, JPEG, WebP and GIF uploads and messages with images (returning 400
when `false`), and images are sent to the default model. Per-model
`aiChat.models.<id>.images` (default `false`) only controls whether images are
sent to that model or replaced with a one-line text placeholder; if an agent
uses a model with `images: false` while `aiChat.llm.images` is `true`, the
attach button is still shown but images are not sent to that model. **When a
model has `images: true`, attached images are sent to its server** as part of
the message, so they leave your organization when the server is outside it.
Leave `images` off (the default) when they must not. The backend stores the
images in its database, per session; the owner of the session reads them, and
so does a sharee who sees the message that has the image. An image that no
message uses is deleted after 24 hours.

`input.images.tokensPerImage` (default 1600) is how many tokens one image
counts in the context budget. It is an estimate, and it has not been measured
against a real model. Set it for the model you use. Too low, and the input can
pass the context limit of the model; too high, and older images are left out
sooner.

**Retention.** A task runs every hour and deletes a session whose last change
is older than `aiChat.retention.days` (default 90; one day is 24 hours),
together with its runs, messages, queued messages and images. The audit log
is kept. A session with a run that has not ended is kept until that run ends.
Pinning or archiving a session does not keep it past the limit; a rename, a
pin, an archive or a change of toolsets does count as a change, and so does a
new message. Set `days` to `0` to keep every session. A session changed
exactly `days` ago is kept.

| Setting                                                  | Meaning                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.images`                                             | Whether the model reads images (`false` by default). When `true`, attached images are sent to the model server as part of the message and leave your organization when that server is outside it.                                                                                                                                                    |
| `maxTurns`                                               | Most model calls in one run.                                                                                                                                                                                                                                                                                                                         |
| `maxToolCallsPerRun`                                     | Most tool calls the model may ask for in one run. A call beyond the limit is answered with "tool call limit" and does not run.                                                                                                                                                                                                                       |
| `maxToolCallsPerStep`                                    | Most tool calls in one answer of the model. A call beyond it is answered with "tool call limit per step", does not run, and counts toward `maxToolCallsPerRun`.                                                                                                                                                                                      |
| `readConcurrency`                                        | Read-only calls of one answer that run at the same time. A call that is not read-only runs alone, after the calls before it, and still needs an approval. The results reach the model in the order it asked for them. A read-only call does not wait for an earlier call that went over `toolTimeoutSeconds`.                                        |
| `toolTimeoutSeconds`                                     | Most seconds of one tool call, at most 600. A call that takes longer gets a timeout result and the run goes on, but the action may still be running. After an action that is not read-only went over its time, the later actions of that answer that are not read-only do not run. `runTimeoutSeconds` still ends the whole run, also during a call. |
| `runsPerUser`                                            | Runs one user may have going on at the same time (running or waiting for an approval), over all sessions and backends. A message beyond it is refused with 429, and a queue waits.                                                                                                                                                                   |
| `llm.requestsPerMinute`, `models.<id>.requestsPerMinute` | Most calls of the model per minute, over all backends that share the database (steps, summaries and titles). A call over the limit waits for the next minute.                                                                                                                                                                                        |
| `llm.reportUsage`, `models.<id>.reportUsage`             | Whether a streamed request asks the server for its token usage (`stream_options: { include_usage: true }`). The tokens go to the logs and metrics (see "Observability"). Set it to `false` for a server that refuses the field.                                                                                                                      |
| `models`                                                 | More models by id, with the fields of `llm`. `llm` is the model `default`. An agent names one with `model`; a backend module can add a model with `addModelClient`.                                                                                                                                                                                  |
| `runTimeoutSeconds`                                      | Most seconds of work in one run, at most 600. The tools run with the token of the user, so a run also ends before that token expires (the shortest life that Backstage allows is 10 minutes).                                                                                                                                                        |
| `context.tokenBudget`                                    | Size of the model input in estimated tokens (one token is a quarter of an ASCII character or one other character). Set it well below the context window of the model.                                                                                                                                                                                |
| `context.keepRecentSteps`                                | The newest steps that are never shortened or left out.                                                                                                                                                                                                                                                                                               |
| `input.insert.maxPerRun`                                 | Most messages the user may insert into one run that is going on (at most 20). The model reads an inserted message in its next call, and a run that is about to end reads it first. A run that stops without reading it (a limit, an error, Stop) leaves it marked as not read.                                                                       |
| `input.queue.maxMessages`                                | Most messages in the queue of one session. A queued message waits for the run to end; when the run ends the normal way (the model answered, no limit stopped it) and the credentials of the user last for another run, the first message starts a new run. After any other end the queue waits until the user continues it.                          |
| `input.images.maxPerMessage`                             | Most images in one message (`4` by default). Needs `llm.images: true`.                                                                                                                                                                                                                                                                               |
| `input.images.maxBytes`                                  | Largest image in bytes (`5242880` / 5 MB by default).                                                                                                                                                                                                                                                                                                |
| `input.images.maxBytesPerInput`                          | Most image bytes sent to the model in one call and across one run (`20971520` / 20 MB by default). Must be at least `maxPerMessage * maxBytes`.                                                                                                                                                                                                      |
| `input.images.maxPendingPerSession`                      | Most uploaded images in one session not yet in any message (`12` by default). Unused images are deleted after 24 hours.                                                                                                                                                                                                                              |
| `input.images.tokensPerImage`                            | Estimated tokens one image uses in `context.tokenBudget` (`1600` by default). Set it for the model you use.                                                                                                                                                                                                                                          |
| `maxToolOutputChars`                                     | The output of an action, and the output of `load_skill`, is cut here, and the cut is stated.                                                                                                                                                                                                                                                         |
| `toolOutput.<pattern>.redact`                            | Field names whose values become `"[redacted]"` in the output of the matching actions, at any depth, before the output is cut. The hidden values are not stored, streamed or sent to the model. An output nested deeper than 100 levels is not kept: the result is an error.                                                                          |
| `toolOutput.<pattern>.maxOutputChars`                    | A lower limit than `maxToolOutputChars` for the matching actions (at least 100). When patterns overlap, the smallest limit and every field apply. `update_plan` and `load_skill` are not actions and keep `maxToolOutputChars`.                                                                                                                      |
| `writesPerMinute`                                        | Most actions that are not read-only one user may run per minute, over all sessions and backends (1 to 10000; no limit when not set). A change over the limit does not run, even after the approval: the result is an error that says so, and the run goes on. Up to twice the limit can run around the turn of a minute.                             |
| `sharing.live.enabled`                                   | Whether a share may keep updating. Default true. `false` refuses a new live share and a new life for one.                                                                                                                                                                                                                                            |
| `sharing.live.defaultHours`                              | Hours a live share lasts when nobody picks a life. Default 24. A positive integer, at most `maxHours`.                                                                                                                                                                                                                                               |
| `sharing.live.maxHours`                                  | Longest life of a live share, in hours. Default 72. A positive integer, at least `defaultHours`.                                                                                                                                                                                                                                                     |
| `retention.days`                                         | Days after the last change of a session before it is deleted, with its runs, messages, queued messages and images. Default 90. `0` keeps every session. A session with a run that has not ended is kept until the run ends. The audit log is kept.                                                                                                   |
| `skills.directories`                                     | Directories read at startup; each subdirectory with a `SKILL.md` is a skill whose body `load_skill` reads when called. A relative path starts at the working directory. A missing directory, bad frontmatter, a link out of the directory, or a duplicate id stops the backend.                                                                      |

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
- Who may use a toolset is the permission `ai-chat.toolset.use` (resource type
  `ai-chat-toolset`, the toolset id). The tools of a toolset the user may not
  use are not offered, the toolset is not listed, and a session cannot switch
  it on. Without the permission framework (`permission.enabled: false`, the
  default of Backstage) everyone may use every toolset.
- **Before you upgrade** with the permission framework on and a default-deny
  policy: allow `ai-chat.toolset.use` (or return CONDITIONAL). Otherwise the
  chat has no tools after the upgrade, and a session made in that time stores
  an empty list of toolsets; the user has to switch them on again.

A permission policy narrows the toolsets with the `isToolset` condition:

```ts
import {
  AuthorizeResult,
  isResourcePermission,
} from '@backstage/plugin-permission-common';
import {
  aiChatToolsetConditions,
  createAiChatToolsetConditionalDecision,
} from '@kwkevinchan/backstage-plugin-ai-chat-backend';

// in handle(request, user) of your PermissionPolicy. `user.info` is
// deprecated; `this.userInfo` is `coreServices.userInfo`, which the module of
// the policy passes to it.
if (isResourcePermission(request.permission, 'ai-chat-toolset')) {
  const info = user && (await this.userInfo.getUserInfo(user.credentials));
  if (info?.ownershipEntityRefs.includes('group:default/sre')) {
    return { result: AuthorizeResult.ALLOW };
  }
  return createAiChatToolsetConditionalDecision(
    request.permission,
    aiChatToolsetConditions.isToolset({ toolsetIds: ['catalog'] }),
  );
}
```

`actions.include` and `actions.exclude` are deprecated. Without `toolsets`
they make the one default toolset, with `toolsets` they are ignored, and the
backend logs a warning when either is set. They will be removed in a later
version.

### Agents

Without `aiChat.agents` there is one agent, `default`: the built-in rules plus
`aiChat.systemPrompt`. An entry in `aiChat.agents` is another agent. An entry
whose id is `default` replaces the built-in one.

The system prompt of a configured agent is the built-in rules plus that
agent's `systemPrompt`. When the agent omits `systemPrompt`, the installation
`aiChat.systemPrompt` is used instead. The two extra texts are not combined.
`toolsets` names toolsets from `aiChat.toolsets` (or `default`, when no
toolsets are configured); only their tools go to the model, `[]` gives none,
and an agent without `toolsets` has them all. A session may still have
another toolset switched on; it gives no tools to that agent. `skills` chooses the skills the agent offers (see
below); an id that no skill has stops the backend. `planning: required`
gives the agent only the `update_plan` tool in the first step of every run, so
it writes a plan before it does anything else. `model` chooses the model of the
agent's runs and titles: `default` (`aiChat.llm`), a key of `aiChat.models`,
or a model client a module added; an unknown id stops the backend. `limits`
are recorded on the agent. A wrong value stops the backend at startup.

Every agent has the read-only built-in `update_plan` tool (`allow` by default;
`policy: { update_plan: deny }` turns it off). Each call replaces the whole plan
(at most 20 steps, each `pending`, `in_progress` or `completed`), the current
plan is in the context of every step, and the chat shows each update as a
checklist.

The loop still uses the limits of the installation. When skills
are registered through `aiChat.skills.directories` (`SKILL.md`) or `addSkill`,
the prompt lists only each allowed skill's `id` and short `description`; the
full instructions are loaded on demand by the read-only built-in `load_skill`
tool (`allow` by default; `agent.skills` restricts which skills that agent sees,
and omitted means all registered skills).

A backend module can register agents, lifecycle hooks, skills and model
clients (`addModelClient`) through
`@kwkevinchan/backstage-plugin-ai-chat-node`. It depends only on that package.
An agent a module registers receives the same built-in prompt rules as a
configured agent. An id that both the configuration and a module define stops
the backend. `addHook` registers `beforeModelCall`, `beforeToolCall`,
`afterToolCall`, and `onRunEnd` hooks. `beforeToolCall` can tighten the
policy to `ask` or `deny` and never relaxes `ask` to `continue`. A hook that
throws fails closed: `beforeModelCall` fails the run, `beforeToolCall` denies
the call, `afterToolCall` turns the result into an error without the output,
and `onRunEnd` is only logged. `onRunEnd` runs once after the run ended,
with the stored status, and the run does not wait for it. `addModelClient`
adds a model only; an id of the configuration stops the backend. The client
reads the bytes of an image with `opts.readImage`, and the rate limit of
`requestsPerMinute` applies only to the models of the configuration.

`addContextProvider` registers a context provider. Before every model call,
each provider returns text for the context of that step, or nothing. The
model gets it in the system prompt as untrusted data, not as instructions,
after the built-in providers: `user` (the entity ref of the user and the refs
they own through), `entity` (a few fields of the entity the session is bound
to, read from the catalog as the user) and `plan` (the current plan). Each
text is cut to 8000 characters, and all of them together to 16000. The loop
waits at most 5 seconds for a provider; when one throws or does not answer,
the model is told that this context is not available, and the run goes on.
The ids `user`, `entity` and `plan`, or a repeated id, stop the backend.

`plugins/ai-chat-backend-module-example` in this repository is a private
example of such a module, to copy from. It registers the agent `guide`, the
skill `getting-started`, the model client `example-echo`, which calls no
server and which no agent uses, and the context provider `docs-site`. It is
not a package to install. The example uses `guide`, so `aiChat.agents.guide`
would also stop the backend.

Any OpenAI-compatible server works, for example a local server: set `baseUrl`
to `http://localhost:11434/v1` and leave out `apiKey`.

### TechDocs search

The chat searches TechDocs with the `search:query` action of the Backstage
search backend (`@backstage/plugin-search-backend`). This plugin adds no
search action of its own. Install the search backend with its TechDocs
collator (`@backstage/plugin-search-backend-module-techdocs`), add `search` to
the list you already have in `backend.actions.pluginSources` (the setting
replaces the whole list), and offer the action in a toolset:

```yaml
backend:
  actions:
    pluginSources: [catalog, search] # your list, plus search
permission:
  enabled: true # without it, the search backend does not filter by permission
aiChat:
  toolsets:
    docs:
      title: Docs
      actions: ['search:query']
      default: true
  agents:
    docs:
      title: Docs
      systemPrompt: >-
        Answer from TechDocs. Search with the type techdocs and a pageLimit of
        5. Cite every result you use with a Markdown link to its location.
```

- The action runs as the user who sends the message. The search backend
  removes the documents that user may not read only when `permission.enabled`
  is `true`. A TechDocs document needs `catalog.entity.read` on its entity.
  Without the permission framework, every user finds every document.
- `permission.enabled: true` turns on the permission framework for the whole
  Backstage installation, not only for the search: every plugin then asks the
  permission backend (`@backstage/plugin-permission-backend`) for its
  decisions. Install that backend with a policy that decides
  `catalog.entity.read`.
- `search:query` is read-only, so it runs without approval unless `policy`
  says otherwise. The model sees it as `search_query` (a tool name cannot hold
  `:`).
- The text of a result is the text of one section of a page; the chat reads
  documents from the results. The TechDocs backend has
  `techdocs:get-techdocs-metadata`, which gives the structure of a site, not
  its text. To offer it, add `techdocs` to `backend.actions.pluginSources` and
  the action to a toolset.
- Every result has `document.title` and `document.location`. The location is
  a path (`/docs/...`), and the chat resolves single-`/` Markdown links against
  `app.baseUrl` (same-origin only), so the model can cite `document.location`
  directly. Keep the default `search.collators.techdocs.locationTemplate`:
  it applies to the whole search index, and the search box of the TechDocs
  reader goes to the location as a path inside the app.
- The input schema of the action has recursive `$ref` entries (in `filters`).
  A model server that does not accept `$ref` in a tool schema refuses the
  request.
- An error of the search comes back to the model as
  `Request failed with <status> <text>`, without the error of the search
  engine. A search that does not answer gets a timeout result after
  `toolTimeoutSeconds`, or ends the run at `runTimeoutSeconds` if that comes
  first.
- The output counts against `maxToolOutputChars`. The action returns 10
  results by default (`pageLimit`); when the output is cut, the last results
  and their links are lost, so ask for fewer results, as above.

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

## Observability

The plugin writes one log line for each model call, each tool result and each
run that ends, and records OpenTelemetry metrics through the metrics service of
Backstage (`@alpha`). They hold numbers, ids and fixed words only: no message,
prompt, context, tool input or output, error text of a tool or of the model
server, or user. A failed model call is logged with the name and the HTTP status
of its error only, as its text may repeat what the conversation said.

| Log line     | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Model call` | `sessionId`, `runId`, `agentId`, `modelId`, `purpose` (`step`, `summary`, `title`), `step`, `durationMs`, `outcome` (`ok`, `empty`, `failed`, `cancelled` (the user stopped the run, the backend shut down or lost the lease), `timeout`), `errorStatus`, `inputTokens`, `outputTokens`, `toolCallsRequested`, `context` (the estimated tokens by part and the counts), `providers` (each context provider with its status and length) |
| `Tool call`  | `sessionId`, `runId`, `agentId`, `step`, `position`, `callId`, `toolId` (`unknown` when the model named a tool that is not offered), `readOnly`, `status`, `reason` (why it was denied: `policy`, `run_limit`, `step_limit`, `hook`, `user`, `earlier_write_timed_out`), `durationMs` (calls that ran), `truncated`                                                                                                                    |
| `Run ended`  | `sessionId`, `runId`, `agentId`, `status`, `endReason`, `stepsUsed`, `toolCallsUsed`, `elapsedSeconds`                                                                                                                                                                                                                                                                                                                                 |

| Metric                             | Type      | Unit       | Attributes                             |
| ---------------------------------- | --------- | ---------- | -------------------------------------- |
| `ai_chat.model.duration`           | histogram | `s`        | `agent`, `model`, `purpose`, `outcome` |
| `ai_chat.model.tokens`             | histogram | `{token}`  | `agent`, `model`, `purpose`, `type`    |
| `ai_chat.context.tokens`           | histogram | `{token}`  | `agent`, `part`                        |
| `ai_chat.context_provider.results` | counter   | `{result}` | `agent`, `provider`, `status`          |
| `ai_chat.tool.calls`               | counter   | `{call}`   | `agent`, `tool`, `status`, `reason`    |
| `ai_chat.tool.duration`            | histogram | `s`        | `agent`, `tool`, `status`              |
| `ai_chat.model.rate_limit.wait`    | histogram | `s`        | `model`, `outcome`                     |
| `ai_chat.run.duration`             | histogram | `s`        | `agent`, `status`, `end_reason`        |
| `ai_chat.run.steps`                | histogram | `{step}`   | `agent`, `status`                      |
| `ai_chat.run.tool_calls`           | histogram | `{call}`   | `agent`, `status`                      |

- The tokens are the ones the model server reports (`reportUsage`); a server
  that reports none leaves them out. The size of the context is the estimate
  the plugin uses for its budget.
- The metrics have no session, run, call or user attribute; the log lines do
  have the ids, so a run can be followed there and matched with the auditor
  records by `runId` and `callId`.
- The meter is `backstage-plugin-ai-chat`. Without an OpenTelemetry SDK in the
  backend, the meter does nothing with the metrics and sends nothing; to export them, set up
  OpenTelemetry as the Backstage documentation describes.
- There are no traces.

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
  refused. A user changes only their own sessions. Reading a session uses the
  permission `ai-chat.session.read`: the owner, or someone a share names, can
  read, unless a policy tightens that (see below).
- The actions run with the credentials of the user, so the permissions and
  policies of the plugins that own the actions apply as they do on their own
  pages.

### `ai-chat.session.read`

The plugin registers this permission and two conditions, `isSessionOwner` and
`isSharedWith`. What the policy returns changes who can open a session:

1. **DENY** refuses even the owner. A default-deny policy (every permission
   that is not granted is DENY) will make every session open as not found
   after you upgrade, until the policy allows this permission.
2. **ALLOW** does not widen the range. Granting a role ALLOW does not let it
   read every session: the plugin still checks the owner and the shares.
3. **CONDITIONAL** applies only the conditions the policy returned. If the
   policy grants only `isSharedWith`, the owner cannot read their own session.

A policy that keeps the default behaviour is an `anyOf` of the two
conditions, with the caller's identity:

```ts
if (isPermission(request.permission, aiChatSessionReadPermission)) {
  return createAiChatConditionalDecision(request.permission, {
    anyOf: [
      aiChatSessionConditions.isSessionOwner({
        userRefs: [userEntityRef],
      }),
      aiChatSessionConditions.isSharedWith({
        subjectRefs: [userEntityRef, ...ownershipRefs],
      }),
    ],
  });
}
```

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

| Route                                                                         | Does                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /sessions`, `POST /sessions`                                             | List, create                                                                        |
| `GET /sessions/:id`                                                           | Read with the items, the run that has not ended, `awaitingDecision` and `resumable` |
| `PATCH /sessions/:id`, `DELETE /sessions/:id`                                 | Change title, pin, archive or toolsets; delete                                      |
| `POST /sessions/:id/runs`                                                     | Send a message and stream the run; `text/event-stream`                              |
| `POST /sessions/:id/runs/:runId/cancel`                                       | Ask a run to stop (`202`)                                                           |
| `POST /sessions/:id/tool-calls/:callId/decision`                              | Allow or deny a waiting call; JSON, or the stream when it was the last one          |
| `POST /sessions/:id/resume`                                                   | Carry on a run whose decisions are all stored (`204` if none)                       |
| `GET /sessions/:id/stream`                                                    | Join a run that is under way (`204` if none)                                        |
| `GET /sessions/:id/shares`, `POST /sessions/:id/shares`                       | List the shares that are not cancelled, share read-only (the owner only)            |
| `PATCH /sessions/:id/shares/:shareId`, `DELETE /sessions/:id/shares/:shareId` | Refresh a snapshot, show or hide tool output, give a live share a new life; cancel  |
| `GET /toolsets`                                                               | The toolsets the user can switch on in a session                                    |
| `GET /sessions/:id/tools`                                                     | The tools a session offers now: title, description, `readOnly` (the owner only)     |

The streams are the [AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
(`ai@7`): a call that needs approval is a `tool-approval-request`, and the
transient `data-run` part tells the state of the run before the stream ends.
A failed run ends with a fixed error text. The types are in
`@kwkevinchan/backstage-plugin-ai-chat-common`.

## Compatibility

| This plugin | Backstage       |
| ----------- | --------------- |
| `0.1.x`     | 1.56 (`1.56.2`) |

The actions service and the metrics service are `@alpha` in Backstage, so a
Backstage upgrade can break this plugin until it is updated.

## Not in this version

An entity tab or sidebar widget (the backend lists the sessions of an entity),
sessions shared with the user in the list of an entity, file uploads,
several model providers at once, MCP servers outside Backstage, an agent's model
and limits (those fields can be set, and a module can register them; the loop
does not use them yet), and a session list that can search, pin or archive (the
page still lists recent sessions; a title is stored after the first round ends
normally).

Limits of this version:

- A client can follow a run that is still going on any backend. The backend
  that runs the loop sends the text already written, then the rest of that
  message as it arrives; any subsequent reply in the same run on that stream is
  sent whole when complete. Another backend polls about once a second and sends
  each finished item as one piece without step boundaries between polled items,
  and ends the stream when the run leaves `running` (always reporting
  `"The run stopped."` for `failed` or `expired`). A run that waits for an
  approval, a run that ended, or no run answers `204`.
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

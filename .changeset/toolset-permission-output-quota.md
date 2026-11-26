---
'@kwkevinchan/ai-chat-harness': patch
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Decide who may use which toolset, hide fields of tool outputs and limit them per action, and limit the changes of each user per minute.

- The permission `ai-chat.toolset.use` (resource type `ai-chat-toolset`, the toolset id) decides who may use a toolset. The tools of a toolset the user may not use do not go to the model, `GET /toolsets` does not list it, and a session cannot switch it on (400). A toolset a session already has stays switched on and gives its tools again when the user may use it. Without the permission framework everyone may use every toolset, as before. A policy narrows it with `aiChatToolsetConditions.isToolset({ toolsetIds })` and `createAiChatToolsetConditionalDecision`, exported by the backend package.
- The `toolsets` of an agent now limit its tools: only the tools of the toolsets it names go to the model, and `[]` gives none. An agent without `toolsets` has them all.
- `aiChat.toolOutput` sets, by action ID pattern, a lower `maxOutputChars` and the field names to `redact`. A hidden value becomes `"[redacted]"` at any depth, before the output is cut, and it is not stored, streamed or sent to the model. The same happens again after the last `afterToolCall` hook. An output nested deeper than 100 levels is not kept: the result is an error.
- `aiChat.writesPerMinute` limits the actions that are not read-only one user may run per minute, over all sessions and backends, with a new table. A change over the limit does not run, even after the approval; the result is an error that says so, and the run goes on.

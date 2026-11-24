---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

Breaking change: the HTTP API and the response stream of the backend are new. Release it together with the frontend plugin that uses them (the frontend still calls the old routes and stops working with this backend).

- The routes are under `/sessions` instead of `/conversations`: create, list, read (with `awaitingDecision` and `resumable`), change and delete a session; `POST /sessions/:id/runs` to send a message; `POST /sessions/:id/runs/:runId/cancel`; `POST /sessions/:id/tool-calls/:callId/decision` (a stored decision, answered with JSON, or with the stream of the run when it was the last one); `POST /sessions/:id/resume`; `GET /sessions/:id/stream` to join a run that is under way; `GET /toolsets`.
- The response stream is the AI SDK UI message stream (`ai@7`) instead of the old `ChatEvent` stream. A call that needs approval is a `tool-approval-request`; a failed run ends with a fixed error text and never shows the text of the model server; summaries and a trimmed context are `data-notice` parts.
- The old tables `conversations`, `messages` and `tool_calls` are dropped by a migration, and their rows are not moved to the new tables. Export what you need before you update.
- The shared types and the paths of the routes are in `@kwkevinchan/backstage-plugin-ai-chat-common`. The backend no longer exports `/common`.
- A stop request that arrives while a run writes its wait for an approval now ends the run as `cancelled` for the subscribers too, so the screen does not show approval buttons of a cancelled run.

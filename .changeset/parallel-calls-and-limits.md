---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Run the read-only calls of one step at the same time, and add limits per step, per tool call and per user, model clients, and rate limits for models.

- The read-only tool calls of one answer run at the same time, at most `aiChat.readConcurrency` (default 4). A call that is not read-only still runs alone and still needs an approval. The results reach the log, the stream and the model in the order the model asked for them.
- Each tool call has a timeout, `aiChat.toolTimeoutSeconds` (default 60, at most 600). A call that takes longer gets a `timeout` result and the run goes on. `runTimeoutSeconds` still ends the whole run.
- `aiChat.maxToolCallsPerStep` (default 8): the calls beyond it in one answer are refused with "tool call limit per step".
- `aiChat.runsPerUser` (default 3): the runs one user may have going on at the same time, over all sessions and backends. A message beyond it gets 429 `TooManyActiveRuns`; a queue waits.
- `aiChat.models` adds models that an agent names with `model`; `aiChat.llm` is the model `default`. Each model may set `parallelToolCalls` and `requestsPerMinute`, a rate limit shared by all backends through a new table.
- `aiChatHarnessExtensionPoint.addModelClient(id, client)` adds a model client from a backend module. It never replaces a model of the configuration. The client reads the bytes of an image with `opts.readImage`.
- Breaking for code that calls the core directly: `AdvanceRunRequest` takes the `model`, `AdvanceRunDeps` no longer does, and `Limits` has `maxToolCallsPerStep`, `readConcurrency` and `toolTimeoutSeconds`.

---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Log and measure every model call, tool result and run, with no content of the conversation.

- The backend writes one log line for each model call (`Model call`), each tool result (`Tool call`) and each run that ends (`Run ended`), and records OpenTelemetry metrics (`ai_chat.*`) through the metrics service of Backstage: durations, outcomes, the tokens the model server reports, the estimated size of each part of the context, the status of each context provider, why a tool call was denied, and the wait for a rate limit. They hold numbers, ids and fixed words only. Without an OpenTelemetry SDK in the backend the metrics go nowhere.
- A streamed request asks the model server for its token usage (`stream_options: { include_usage: true }`). `aiChat.llm.reportUsage` and `aiChat.models.<id>.reportUsage` (default `true`) turn it off for a server that refuses the field.
- A failed model call is logged with the name and the HTTP status of its error, no longer with its text. A hook or a context provider of a module that throws is logged with the name of its error, no longer with its text.
- `ModelChunk` has a `usage` chunk (`inputTokens`, `outputTokens`). A model client of a module may yield it; the loop only measures it.
- The core has an optional `RunObserver` in `AdvanceRunDeps` (`modelCall`, `toolCall`), `modelId` in `AdvanceRunRequest`, and `modelInputOf` and `sizeOfModelInput`, which give the size of a model input. The deadline of a run aborts its signal with a reason named `TimeoutError`.

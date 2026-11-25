---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add lifecycle hooks (`addHook`) to `@kwkevinchan/backstage-plugin-ai-chat-node` and the agent loop (`X-05`): `beforeModelCall`, `beforeToolCall`, `afterToolCall`, and `onRunEnd`.

Backend modules can register hooks through `aiChatHarnessExtensionPoint.addHook(...)`. In the loop, `beforeToolCall` can tighten tool policy (`ask` or `deny`) without relaxing `ask` to `continue`, failing hooks fail closed cleanly, `afterToolCall` transforms tool output consistently across the database log and stream, and `onRunEnd` runs after terminal outcomes with error isolation.

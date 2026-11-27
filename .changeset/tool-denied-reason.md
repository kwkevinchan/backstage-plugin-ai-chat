---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

- Add optional `deniedReason` (`user`, `policy`, `run_limit`, `step_limit`, `earlier_write_timed_out`, `hook`) to `tool_result` items when `status` is `denied`, and stream it via `tool-approval-response.reason`.
- Show a distinct `Blocked` state and readable reason on tool call cards when a tool is blocked by the system (including `Allowed, but blocked: …` when a user-approved write is skipped because an earlier write in the same step timed out).

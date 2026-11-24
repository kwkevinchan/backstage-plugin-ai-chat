---
'@kwkevinchan/ai-chat-harness': minor
---

Apply the context budget to the model input: the outputs of old tool calls become one line, then the old steps are summarized by a model call (`summarize`, a new `summary` item) or left out when that fails. Add `planSummary`, `buildSummaryInput`, `estimateTokens` and `SUMMARY_PROMPT` to the domain, the `summary.started` and `summary.failed` events, and the `fromLatestSummary` option of `ItemLog.read` (covered by `itemLogContract`), which the loop uses to read only what the newest summary does not cover.

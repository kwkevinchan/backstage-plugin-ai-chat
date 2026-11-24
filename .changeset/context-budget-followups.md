---
'@kwkevinchan/ai-chat-harness': minor
---

Public additions of the context budget: the event `context.trimmed` (`HarnessEvent` has one more member, so a host that switches over the event types without a default must handle it; it is sent when the parts of the input left out change, not at every step), `trimmedPartsOf` and `SUMMARY_RESERVE_TOKENS`. `ItemLog.read` with `fromLatestSummary` treats a newest summary whose `coversUpToSeq` is not a finite number as no summary and reads everything.

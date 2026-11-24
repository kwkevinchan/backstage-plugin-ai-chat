---
'@kwkevinchan/ai-chat-harness': minor
---

Let a message be inserted into a run that is running. `user_message` items have `delivery` (`direct`, `inserted` or `queued`; no value means `direct`), and `agent_message` and `tool_call` items have `readUpToSeq`, the largest sequence number the loop had read when the model call began. The loop does not complete while an inserted message is unread: it calls the model once more, within the step limit. `decideNextAction` finds the calls of the last step after the first message of the run, `buildModelInput` places an inserted message after the tool results of its step, keeps the first message and the inserted messages as written and leaves out unread inserted messages of runs that have ended. New: `unreadInserted`, `insertStatesOf`, the `message.read` event, and the `Delivery` and `InsertState` types.

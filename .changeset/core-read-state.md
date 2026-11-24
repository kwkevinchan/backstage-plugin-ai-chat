---
'@kwkevinchan/ai-chat-harness': minor
---

Rename the type `InsertState` to `ReadState`. It says whether the model read an inserted message (`read` or `unread`, the values of `insertStatesOf`), and the host has its own state of an inserted message that also knows `pending`, so the two no longer share a name.

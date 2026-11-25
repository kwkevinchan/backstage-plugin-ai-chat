---
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Add `POST /sessions/:id/queue/:queuedId/insert` to move a queued message into a running run as an inserted message ("send now").

In one transaction, the backend checks that `runId` belongs to the session, is `running`, and has a live lease, removes the queued message, checks the per-run insert and image-byte limits, writes a `user_message` with `delivery: 'inserted'`, and marks its images as used (preserving holds for any remaining queued message that still lists them). Remaining queued messages keep their order, and the queue pause state is unchanged. Invalid run states or insert limits return `409` without modifying the queue, and missing or already-sent queued items return `404`. `@kwkevinchan/backstage-plugin-ai-chat-common` adds `chatPaths.insertQueuedMessage` and `InsertQueuedMessageRequest`, and `AiChatApi` / `AiChatClient` add `insertQueuedMessage`.

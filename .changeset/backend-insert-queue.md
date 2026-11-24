---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

Add messages inserted into a run, and the queue.

- `POST /sessions/:id/runs/:runId/messages` adds a message to the run that is running. The model reads it in its next call; a run that is about to end reads it first, because the status change checks the log in the same transaction that locks the run (`runs.read_up_to_seq`, written together with the output of each model call). The request answers 201 with the item, or 409 `RunNotRunning` or `InsertLimitReached` (`aiChat.input.insert.maxPerRun`, 5 by default).
- `GET`, `POST /sessions/:id/queue`, `PATCH`, `DELETE /sessions/:id/queue/:queuedId`, `PUT /sessions/:id/queue/order` and `POST /sessions/:id/queue/resume` keep the messages that wait for the run to end (`aiChat.input.queue.maxMessages`, 5 by default). When a run ends the normal way and the credentials of the user last for another run, the first message starts a new run (`delivery: queued`) and the audit log gets `queued-message-send`; after any other end the queue is paused until the user continues it.
- The response stream has the parts `data-inserted` (an inserted message the model read) and `data-queue` (the queue when the run ended). `GET /sessions/:id` has `queue` and an `insertState` on each inserted message.
- A migration adds `runs.read_up_to_seq` and the table `queued_messages`.

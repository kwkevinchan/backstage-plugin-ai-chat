---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Write to the chat while a run goes on.

- The input box stays usable. While the run is running, Enter adds the message to the run and Ctrl or Cmd with Enter (or the Queue button) queues it; while the run waits for a decision, both queue it. A message the model has not read yet shows above the box; once it reads it, the message moves into the conversation before the step that read it. A refused insert is read again and then queued, inserted into the new run, or sent as a new message.
- The queue shows above the box: edit a message in place, delete it, move it up or down. When a run ends the normal way the queue sends its next message and the page follows that run without a reload. A paused queue says why and has Continue; a message sent while it is paused runs first, and the queue follows when that run ends.
- A message the run ended without reading says so. When the run gave an answer, each such message has its own resend button; when it did not, the run has the one button, which sends the first message of the run again.
- `AiChatApi` has `insertMessage`, `getQueue`, `queueMessage`, `updateQueuedMessage`, `deleteQueuedMessage`, `reorderQueue` and `resumeQueue`.

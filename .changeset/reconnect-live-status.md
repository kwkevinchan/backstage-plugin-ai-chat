---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Follow a run that is still going after a reload, including a run on another backend. The backend that runs the loop sends the text already written and then the rest of that message; subsequent replies in the same run on that reconnect stream are sent whole when complete. Another backend polls once a second for completed items (without token deltas or step boundaries between polled steps), sends each new item whole, and ends the stream when the run leaves `running` (using `"The run stopped."` for `failed` or `expired`). A run that waits for an approval, a run that ended, or no run still answers 204.

`GET /sessions` adds `activity` (`running` or `waiting_approval`) when a run has not ended, and `aiChatSignalsModule` pushes session activity changes (`running`, `waiting_approval`, `replied`, `idle`) to the owner on the `ai-chat` Signals channel. `useSessionChat` accepts `liveActivity` to reconnect when an open idle session becomes `running` and reload when an active run ends.

---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Follow a run that is still going after a reload, including a run on another backend. The backend that runs the loop sends the text already written and then the rest. Another backend sends each finished item about once a second, as one piece, and ends the stream when the run leaves `running`. A run that waits for an approval, a run that ended, or no run still answers 204.

`GET /sessions` adds `activity` (`running` or `waiting_approval`) when a run has not ended. The page shows Processing, Waiting for approval, or New reply. Without Signals the page reads the list about once a second. To push those changes, install the Signals backend and frontend plugins and add `aiChatSignalsModule` from this package.

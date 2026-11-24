---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Delete sessions that are past `aiChat.retention.days` (default 90; one day is 24 hours). A task runs every hour and deletes a session whose last change is older than that, together with its runs, messages, queued messages and images. The audit log is kept. A session with a run that has not ended is kept until that run ends. Set `days` to `0` to keep every session.

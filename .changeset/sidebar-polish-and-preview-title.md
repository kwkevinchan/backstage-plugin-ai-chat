---
'@kwkevinchan/backstage-plugin-ai-chat': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

- Add `previewTitle` to `GET /sessions` (`ChatSession.previewTitle`) derived from the first user message while a session has no saved title yet, using a single bounded query per list request.
- Poll the session list every 3 seconds when Backstage Signals is not installed and a session has an active run, and show the `New reply` badge on non-open sessions that finish during polling.
- Replace the double focus ring on the session list search input with a single inset focus outline.

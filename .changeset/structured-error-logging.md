---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

Mask error messages that may carry external, user, model, or tool content (logging only error name, short code, and HTTP status), while logging full `Error` objects (including message and stack) for internal backend and infrastructure errors.

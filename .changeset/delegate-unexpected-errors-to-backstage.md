---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

Delegate unexpected HTTP errors directly to Backstage's default error handler instead of replacing them with a generic `Error('The request failed.')`, so backend logs retain the original error message and stack trace, error responses carry the original error name and message (preserving numeric `statusCode`/`status` when present, otherwise 500), and PostgreSQL `DatabaseError` responses are filtered by Backstage to a `logId`.

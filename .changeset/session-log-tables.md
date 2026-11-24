---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add the tables of the new session log (`sessions`, `runs`, `items`) in a migration, with the database adapters of the core ports: `KnexItemLog`, `KnexSessionRepository` and `KnexRunRepository`. The tables of the first version stay as they are; nothing reads the new tables yet. The backend now depends on `@kwkevinchan/ai-chat-harness`.

---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

Deleting a session locks its runs before the session row, so a write that already holds a run waits its turn instead of deadlocking with the delete.

The backend refuses to start when SQLite's connection pool allows more than one connection. SQLite does not take the row locks this plugin uses, and a second connection can fail a transaction with `SQLITE_BUSY` instead of the result those locks define. Knex's default for SQLite is one connection, which is unchanged. Use PostgreSQL when more than one connection is needed.

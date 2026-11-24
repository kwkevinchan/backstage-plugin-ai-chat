---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

A client that joins a run under way (`GET /sessions/:id/stream`) no longer gets an empty extra step when the first step of the run has only text and no tool call. The README describes the settings of this version: `toolsets`, `policy`, the limits of a run, the context budget and the deprecated `actions.include` and `actions.exclude`.

---
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Add session sharing UI and session copying (fork):

- Add `POST /sessions/:id/fork` (`ForkSession`) copying only visible `user_message`, `agent_message`, and `plan_update` items (omitting tool calls, tool outputs, approvals, summaries, notes, queued messages, and shares), duplicating in-scope user message images as isolated attachments owned by the caller, and recording a `session-fork` audit event.
- Add `ChatSharedView` (`ChatSessionDetail.shared`) on `GET /sessions/:id` for sharees indicating `snapshot` (with `snapshotAt`) or `live` (with `expiresAt`).
- Add `ShareDialog` with permission/copy/group disclosures, persistent owner live-sharing banner with stop buttons, and read-only sharee view with snapshot/live banner and "Copy to my sessions" button.

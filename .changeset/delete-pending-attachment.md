---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

- Add `DELETE /sessions/:id/attachments/:attachmentId` to delete a session owner's pending (unused, unreserved) uploaded image attachment (`204` on delete, `404` when not found or not owned, `409` when already used or reserved by a queued message), audited as `attachment-delete`.
- Add required `deleteAttachment(sessionId, attachmentId)` method to `AiChatApi` and call it when a user removes a draft image from the composer before sending.

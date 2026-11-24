---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

The model is told where the user is. The page that a message is sent from (`page`: the path and the entity) is stored with the `user_message` item (`UserMessageBody.page`, `PageContext`), and `buildModelInput` puts one line before the text of that message ("The user is on the page of <entity> (<path>)."); it is in the message, not in the system prompt. Items that were written before have no page and read as before.

`GET /sessions/:id/tools` (new, `ChatTool`, `ChatToolList`, `chatPaths.tools`) lists the tools a session offers, with the credentials of the owner: id, title, description and whether it only reads. `ToolDescriptor` has an optional `title`, which the actions gateway fills.

---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

The model is told where the user is. The page that a message is sent from (`page`: the path and the entity) is stored with the `user_message` item (`UserMessageBody.page`, `PageContext`), and `buildModelInput` puts one line before the text of that message ("The user is on the page of <entity> (<path>)."); it is in the message, not in the system prompt, and each value is written as a JSON string, so a line break or a quote cannot end the line. The client gives the page, so the backend checks its form (`isEntityRef`, `isPagePath` of the common package; 400 otherwise) and the page leaves out what does not pass. Items that were written before have no page and read as before.

`GET /sessions/:id/tools` (new, `ChatTool`, `ChatToolList`, `chatPaths.tools`) lists the tools a session offers, with the credentials of the owner: id, title, description and whether it only reads. `ToolDescriptor` has an optional `title`, which the actions gateway fills.

A result with status `unknown` is sent as the fixed error text `TOOL_RESULT_NOT_KNOWN`, which the screen shows as "result unknown".

---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

First release: a chat in which a signed-in user talks to a model that calls the actions of the Backstage actions registry as that user. Actions that only read run at once; every other action waits for the approval of the user in the chat, and approval runs the stored input, once, for the owner of the conversation.
